# Duplicate billing — rollout runbook

The code is deployed. **The backfill has not been run against any real
environment** — only against a disposable local Postgres. Running it is the
remaining step, and the report it prints needs a person to read it.

## Why

The same delivery could be billed on two invoice lines and both would come back
`MATCHED`. Demonstrated before the fix, one 24.6 tonne load on two lines:

```
line-A: MATCHED  coverage=true  tickets=[ticket-1]
line-B: MATCHED  coverage=true  tickets=[ticket-1]
```

`verifyInvoice` also flipped invoices to `VERIFIED` without consulting any
verdict, so every check the engine ran could be skipped by clicking Verify.

## What changed

A load is spent by a **person**, not by the engine. Confirming or overriding a
verdict writes a `TicketClaim` for exactly the tickets that verdict counted
(`MatchResult.ticketIds`); rejecting or reopening releases them. `ticketId` is
unique, and that constraint — not the check — is the real protection: it is what
decides the case where two people confirm competing lines in the same instant.

Two checks report it. `ticketReuse` fails when the remaining unclaimed tickets
cannot cover the line, naming the invoice that already used them.
`duplicateBilling` fails while another unreviewed invoice bills the same PO;
confirming into that contention requires a note.

Verifying an invoice now refuses on unresolved findings, refuses lines nothing
has evaluated, and confirms clean lines so that verifying really does spend the
tickets.

## The gap this runbook closes

Claims only know about loads spent **since the feature shipped**. Every invoice
verified before that has no claim, so its tickets still look available and a
repeat bill would match cleanly. On a database that has been in use for months,
that is most of the data.

`npm run backfill:ticket-claims` reads what the old system recorded — the
tickets attached to lines on invoices that reached `VERIFIED` or `PAID` — and
claims them.

## Order of operations

### 1. Confirm the deployed build

```bash
curl -s https://cambridge-garden-centre-production-0f60.up.railway.app/api/health
```

Verified 2026-09-12: `{"status":"ok","commit":"10c507b","builtAt":"2026-09-12T10:47:23.000Z"}`
— the merge commit of the duplicate-billing work. Railway runs
`npm run db:migrate` as its `preDeployCommand`, so a successful deploy implies
the `TicketClaim` migration applied; that was inferred from the deploy
succeeding, **not** confirmed by inspecting the production database. Confirm
directly before running the backfill:

```sql
SELECT count(*) FROM "TicketClaim";
```

A missing relation here means the migration did not run, and the backfill must
not be attempted until it has.

### 2. Dry run the backfill

```bash
npm run backfill:ticket-claims
```

Writes nothing. Prints four counts and two lists. Example from a seeded local
database:

```
  already claimed:  0
  claimable:        1
  contested:        1
  unattributed:     0

CONTESTED — one load, two settled invoice lines. Read these first:
  ticket 88213
      INV-1001 line 1 (VERIFIED)
      INV-1007 line 1 (VERIFIED)
```

### 3. Read CONTESTED before applying anything

**A contested load is a load billed on two invoices that were both settled.**
One of them was probably paid twice, and that already happened — it is not a
problem the backfill introduces or can fix. The run deliberately claims neither
side, because picking one would bury the evidence.

Each contested entry needs a person to decide which invoice was the real one,
using the tickets and the Spruce order. Expect this list to be short. If it is
long, stop and escalate rather than working through it alone: a long list means
the old system was double-paying routinely, which is a finance question, not a
software one.

`UNATTRIBUTED` means a settled invoice has no recorded verifier, so there is no
honest name to put on the claim. Those are reported rather than attributed to
whoever runs the script.

### 4. Apply

```bash
npm run backfill:ticket-claims -- --apply
```

Writes claims only for loads held by exactly one settled line, attributed to the
person who verified that invoice and dated when they verified it — not when the
script ran. Contested and unattributed loads are left alone.

Safe to re-run: it skips tickets that already have a claim, so an interrupted
pass resumes, and it can be run again after contested cases are settled by hand
to claim the survivors.

### 5. Afterwards

Spot-check that a historical invoice's loads are now spent:

```sql
SELECT t."ticketNumber", i."invoiceNumber", c."claimedAt"
FROM "TicketClaim" c
JOIN "Ticket" t ON t.id = c."ticketId"
JOIN "InvoiceLineItem" l ON l.id = c."invoiceLineId"
JOIN "Invoice" i ON i.id = l."invoiceId"
ORDER BY c."claimedAt" DESC
LIMIT 20;
```

## Known limitations

- **Duplicate invoices are not detected.** The same invoice arriving twice — same
  file, or the same invoice number from the same supplier — is still ingested as
  two invoices. Claims stop the second one being *paid* against the same loads,
  which is the expensive half, but nothing stops it being created and nothing
  tells the clerk the two are the same document.
- **Hand-linking writes no claim.** `POST /api/invoices/line-items/link-tickets`
  attaches tickets without spending them, because linking is not a payment
  decision. It refuses tickets another line has already been paid for. The
  spending still happens when a verdict is resolved.
- **A load claimed by a rejected line is released.** That is deliberate — a
  rejected duplicate must not strand the real invoice — but it means a claim is
  not a permanent record of payment. `AuditLog` is.

## Verification baseline

At the time of writing: 477 unit tests, 29 integration tests, frontend 121,
typecheck and build clean. The full migration chain was applied to an empty
Postgres to confirm it stands up from scratch rather than only as a delta.

The integration tests cover what only a database proves: the claim is written and
names who spent it, the second invoice is refused, reopening releases the load,
two simultaneous confirmations leave exactly one claim, and the backfill refuses
to pick a winner between two settled lines.
