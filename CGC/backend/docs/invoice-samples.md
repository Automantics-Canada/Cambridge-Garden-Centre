# Client invoice samples — the dry run

CGC agreed to send one or two recent invoices per main supplier (A13). This
page covers how we ask for them, where they are kept, and how we see what the
app would do with them: `npm run samples:dry-run`.

**Samples never go into production.** They are real invoices, most of them
already paid. They are not forwarded to `ap@cambridgegardencentre.ca` or to
`cgcsoftware1718@gmail.com`, not uploaded in the app, not put in Supabase
storage and not committed to git. The dry run reads them on one of our
machines and writes nothing anywhere except a report beside them.

## What to ask the client for

Send this (edit the names to suit):

> Please email the samples **directly to us** at Automantics, not to
> ap@ and not through the app. For each of your main suppliers, 1–2 recent
> invoices, and with each one:
>
> 1. the **Spruce order numbers and PO numbers** the invoice bills;
> 2. the **driver ticket photos** for those loads (and any tickets the
>    supplier attached to the invoice);
> 3. the **price list or agreed rates** for that supplier;
> 4. whether the invoice is **already paid**.
>
> Also 1–2 **trucking invoices**, with the rate dispatch agreed for each load
> on them.
>
> Send the files exactly as the supplier sent them (PDF, Excel or CSV): please
> do not print, rescan or convert them. If a supplier's email had several
> attachments, send all of them.

The order and PO numbers matter as much as the invoices: production data is
off limits, so the orders, tickets and rates the samples are matched against
are written by hand from what the client sends (see `related.json` below).

## Where the files go

Put everything in `CGC/backend/.samples/` (gitignored) in a worktree whose
`.env`, if it has one, holds only an OpenAI key. `.codex/samples/` at the
repository root is ignored too and works with `--dir`. Driver ticket photos
can go in a subfolder such as `.samples/tickets/`: subfolders are not read as
samples.

The script refuses to run if git would commit any sample or the report.

| File | What it is |
| --- | --- |
| `<anything>.pdf`, `.png`, `.jpg`, `.xlsx`, `.csv` | the samples, one invoice email attachment each |
| `manifest.json` (optional) | per file: supplier, type, Spruce order and PO numbers, invoice number, expected total, already paid, notes. Example: [`invoice-samples/manifest.example.json`](invoice-samples/manifest.example.json) |
| `related.json` (optional) | the suppliers, aliases, orders, driver tickets, agreed rates, dispatch loads and open invoice lines to match against. Example: [`invoice-samples/related.example.json`](invoice-samples/related.example.json) |
| `<file>.extraction.json` | what the model read from `<file>`, saved by `--save-extractions` (or written by hand). Example: [`invoice-samples/extraction.example.json`](invoice-samples/extraction.example.json) |
| `dry-run-report.json` | written by each run |

Every value in the examples is invented. In `related.json`, suppliers are
referred to by `id` or by exact name; dates are `YYYY-MM-DD`; a ticket's
`source` is `MANUAL` or `WHATSAPP` for a driver's or office copy and `EMAIL`
for the supplier's; `claimedBy` marks a load already paid on another invoice
line; `quote: true` marks a quotation line (never a candidate, as in
production).

`dispatchLoads` are the loads dispatch recorded, one entry per load as the
dispatch board lists them: the Spruce `orderNumber`, the `carrier` (a
`TRUCKING_COMPANY` supplier), the `rate` dispatch set with its `rateUnit`
(`LOAD`, `HOUR` or `TONNE`; leave both `null` for a load nobody priced), the
expected `quantity`, the `ticketNumber` dispatch wrote down, the `haulDate`,
and a `tripRef` shared by the loads of one brokered trip (billed once, at the
trip's rate). A trucking company's lines are checked against these, not
against orders and tickets, exactly as production does. An open invoice line
that bills a load names it in `loads`.

## Running it

From `CGC/backend`:

```sh
# Read each sample with the model once and keep what it read (needs OPENAI_API_KEY;
# two model calls per sample, page sorting and the invoice, plus one per ticket page).
npm run samples:dry-run -- --save-extractions

# From then on, offline and free, as often as related.json is refined:
npm run samples:dry-run -- --no-ai

npm run samples:dry-run -- --help
```

Other options: `--dir <path>` for another (ignored) samples folder,
`--related <path>` for a related.json elsewhere, `--no-match` for reading and
totals only, `--only <file>` for one sample, `--no-report` for console only.
The exit code is 1 when any sample could not be read, 2 when the run was
refused.

The model key is the only secret a live run needs. The script sets harmless
placeholders for everything else the server's configuration asks for, before
any `.env` is loaded, so a `.env` with real database or storage credentials is
never used by it.

### Against a loopback database (`--db`)

Instead of `related.json`, the related records can be read from a disposable
database on this machine, for example one where the matching Spruce reports
were imported through a local copy of the app:

```sh
DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/disposable \
  npm run samples:dry-run -- --no-ai --db
```

`DATABASE_URL` must be given on the command line. The script refuses a
missing URL, any host other than `127.0.0.1`, `localhost` or `::1` (also in a
`host=` parameter, and for `DIRECT_URL`), and runs every read inside a
`READ ONLY` transaction, so PostgreSQL rejects a write even if one were added
by mistake.

## What the report says

For each sample, on the console and in `dry-run-report.json`:

- **Intake** — what the inbox would do with the file: read it, skip it
  (unsupported type, iPhone HEIC photo) or send it to a person (old `.xls`,
  unreadable spreadsheet, credit memo).
- **Pages** — how a PDF was sorted (invoice / delivery ticket / statement /
  credit memo / other) and split, exactly as an emailed attachment is. Ticket
  pages are read as tickets and take part in matching as the supplier's copy.
- **Read** — which header fields (supplier, invoice number, date, PO, total)
  and which line fields (description, quantity, unit, price, amount, PO, and
  the trucking ticket number and service date where this build reads them)
  came back, and which the reader marked unsure.
- **Totals** — whether the lines add up to the printed total: as printed, with
  tax lines, or with 13% HST added; lines whose quantity × price is not their
  amount; lines with no amount.
- **Units** — units the matching engine does not recognise (e.g. `ld`, `skd`).
  These are the candidates for new aliases in `src/lib/units.ts`, which are
  added only once real samples confirm what each supplier means.
- **Supplier** — which supplier production would file the invoice under
  (exact, contained or close name), or that it would **create a new
  supplier**, which has no orders or rates and makes every line fail: register
  that name before go-live.
- **Lines** — for each line, the verdict (`MATCHED`, `PARTIAL`, `UNMATCHED`,
  `CONFLICT`) and the flag (`OK`, `RATE_MISMATCH`, `QTY_MISMATCH`, `NO_TICKET`,
  `NO_ORDER`, `RATE_UNKNOWN`, `UNIT_MISMATCH`, `MULTIPLE_FLAGS`) production
  would store, the order and tickets it would use, the agreed rate and the
  approved amount, with each failed check in words. A trucking company's line
  names the dispatch load (or brokered trip) it bills instead, and is checked
  against the rate dispatch set on it: a rate more than 1% off, a load nobody
  priced ("Dispatch has not set a haul rate"), or a load already paid on
  another invoice line all hold it for a person. The values are judged as
  production stores them: an unread quantity or price counts as 0 and an
  unread unit as `unknown`.
- **Invoice note** — the total check production would write on the invoice.
- **Manifest** — anything that differs from what the manifest expected, and
  POs on the invoice the manifest did not list.

The summary adds up field fill rates, totals results, unknown units, verdicts
and flags across all samples.

## What it does not cover

- A trucking sample is only as good as the `dispatchLoads` written for it (or
  the loads in the `--db` database); with none for its carrier, every line
  says no load was found, and the report warns.
- Two samples billing the same PO do not see each other as competing lines;
  only `openInvoiceLines` in `related.json` (or open lines in the `--db`
  database) do.
- Linking an emailed ticket to the driver's copy uses the simple rule (same
  supplier and ticket number, one copy on file).

The preview mirrors production code it cannot call without a database:
`matchInvoiceLineById`'s queries (and, for a trucking line, `matchHaulLineById`'s
loads and competing lines), `processInvoiceOcr`'s stored line values,
`findOrCreateSupplier` and `refreshInvoiceTotalCheck`. They are copied in
`src/modules/matching/dryRunDecision.ts` and, for `--db`, in
`src/scripts/sampleDryRun/loopbackRecords.ts`; when one of those changes,
change the copy too. The verdicts themselves are production's own pure
functions (`matchInvoiceLine`, `matchHaulLine`).
