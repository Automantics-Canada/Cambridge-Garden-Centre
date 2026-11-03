# Local demo: the client's answers of Oct 2026, end to end

A fake but realistic dataset for clicking through every behaviour the client's
answers changed, on a database that lives on your own machine. The browser
tests use the same data.

Everything in it is invented: people, addresses, 555 phone numbers, suppliers
(`*.example` email domains), order numbers `9999-99xxxx` and POs `9999-88xxxx`.
Dates are relative to today's business day in America/Toronto, so the dispatch
board always has work on it, whatever day you run it.

Nothing here touches Supabase, Gmail, OpenAI, Railway or Vercel. Every value
below is local or a dummy.

## 1. A database on loopback

The seed refuses any database that is not on `127.0.0.1`, `localhost` or `::1`,
and refuses to run at all with `NODE_ENV=production`. It empties every table of
the app before seeding.

Start a throwaway Postgres (the same settings the integration tests use):

```sh
docker run -d --name cgc-demo-db \
  -e POSTGRES_USER=cgctest -e POSTGRES_PASSWORD=cgctest -e POSTGRES_DB=cgc_demo \
  -p 127.0.0.1:55432:5432 postgres:16-alpine
```

If a test container already listens on `127.0.0.1:55432`, add a database to it
instead of starting a second one:

```sh
docker exec -it <that-container> createdb -U cgctest cgc_demo
```

Then, in every terminal below:

```sh
export DATABASE_URL=postgresql://cgctest:cgctest@127.0.0.1:55432/cgc_demo
export DIRECT_URL=$DATABASE_URL
```

## 2. Migrate and seed

From `CGC/backend`:

```sh
npx prisma migrate deploy
npm run seed:demo
```

The seed needs nothing but `DATABASE_URL`/`DIRECT_URL` and reads no other
setting. Export both, as above: Prisma fills any variable you leave unset from
`CGC/backend/.env` when that file exists, and the seed checks both URLs (and
refuses) before it writes anything. Run it again whenever you want to start
over: it wipes and re-creates the same data (new ids, same contents).

## 3. Run the backend with local-only settings

Run the demo from a checkout that has **no `CGC/backend/.env`** (a fresh
clone or a git worktree), and do not create one. `src/config/env.ts` calls
`dotenv.config()`, which fills every variable not set on the command line from
that file: a `.env` holding real credentials would bring back the `GMAIL_*`
accounts, `NODE_ENV` and the rest that the settings below leave off. The
command below refuses to start when the file is there.

Pass the environment on the command line instead. These are every variable
`src/config/env.ts` requires, with safe dummy values, plus the switches that
keep everything outbound off:

```sh
cd CGC/backend
if [ -e .env ]; then echo "CGC/backend/.env exists: run the demo from a checkout without one."; else
env -i PATH="$PATH" HOME="$HOME" \
  DATABASE_URL=$DATABASE_URL DIRECT_URL=$DIRECT_URL \
  PORT=4000 \
  JWT_SECRET=local-demo-jwt-secret-not-a-real-secret \
  SUPABASE_URL=http://127.0.0.1:59999 \
  SUPABASE_SERVICE_ROLE_KEY=local-dummy-service-role-key \
  SUPABASE_STORAGE_BUCKET=local-demo-bucket \
  OPENAI_API_KEY=sk-local-dummy \
  WORKER_MODE=off \
  SPRUCE_READER=parser \
  FRONTEND_URL=http://127.0.0.1:5173 \
  npm run dev
fi
```

| Variable | Value | Why |
| --- | --- | --- |
| `DATABASE_URL`, `DIRECT_URL` | the loopback database | required |
| `JWT_SECRET` | any local string | required; signs the demo logins' tokens |
| `SUPABASE_URL` | `http://127.0.0.1:59999` | required; a loopback port nothing listens on, so storage calls fail at once. Do not use `127.0.0.1:54321`: another project's local Supabase may be there |
| `SUPABASE_SERVICE_ROLE_KEY` | dummy | required |
| `SUPABASE_STORAGE_BUCKET` | dummy | required |
| `OPENAI_API_KEY` | `sk-local-dummy` | required; any call to the model fails, nothing is sent |
| `WORKER_MODE` | `off` | the API does not start the Gmail poller, the OCR worker or the matching cron (`src/workers/runtime.ts`). Do not run `npm run dev:worker` |
| `SPRUCE_READER` | `parser` | a report you upload is read by the layout reader only, never sent to the model |
| `GMAIL_*`, `GMAIL_INBOX_*` | **unset** (and no `.env` to fill them) | with no inbox credentials the poller is disabled (`gmailPollDisabledReason`), and the outbound mailer (driver emails, `mail.service.ts`, `GmailService.sendEmail`) has no account to send from. The demo drivers' addresses are `@demo.invalid` as well, which can never be delivered |
| `NODE_ENV` | unset | development. Setting `development` explicitly also turns on Prisma's query log |
| `CORS_ALLOWED_ORIGINS` | unset | an empty list lets the local frontend in outside production |
| `INTERNAL_SHARED_SECRET`, `SUPABASE_ANON_KEY` | unset | optional; the first falls back to `JWT_SECRET` |

On start it says "Supabase Storage connection failed, uploads will not work"
and "Background workers disabled here (WORKER_MODE=off)". Both are expected.

## 4. Run the frontend

From `CGC/frontend`, with Node 22:

```sh
VITE_API_URL=http://127.0.0.1:4000 \
VITE_SUPABASE_URL=http://127.0.0.1:59999 \
VITE_SUPABASE_ANON_KEY=local-dummy-anon-key \
npm run dev -- --host 127.0.0.1
```

Open http://127.0.0.1:5173. (`--host 127.0.0.1` makes Vite listen on that
address; by default it listens on `localhost`, which on macOS may be `::1`
only. The Supabase values only stop the client library from refusing to
load; nothing is sent there. Values given on the command line win over any
`CGC/frontend/.env*` file Vite also reads.)

## 5. Logins

Every demo login shares one password: **`demo-local-only`** (the
`DEMO_PASSWORD` constant at the top of `src/scripts/seedDemo.ts`). It is not,
and must never become, a real password.

| Email | Role | Notes |
| --- | --- | --- |
| `owner@demo.invalid` | OWNER | can approve or ignore unrecognised senders |
| `admin@demo.invalid` | ADMIN | ran both uploads; set the office's choices |
| `ap@demo.invalid` | AP_USER | can look at the sender queue, not approve |
| `driver1@demo.invalid` | DRIVER | Dana: log in at `/login/driver` |
| `driver2@demo.invalid` | DRIVER | Drew: log in at `/login/driver` |

A third driver, Casey Broker (INDEPENDENT, Demo Haulage Ltd.), has no login:
a brokered driver does not use the app.

## 6. What is in it

| Order | What it shows |
| --- | --- |
| 9999-990001 | FOB order, "FOB EXAMPLESTONE AYR", dated today: the customer collects |
| 9999-990002 | the same kind of FOB order, set by the office to "Delivery via supplier"; on Dana's run |
| 9999-990003 | "Examplestone Direct Delivery" line: stays CGC work, with a check |
| 9999-990004 | a quotation (Item Tracking only, dated today) |
| 9999-990005 | PitBlk, dispatch chose Sample Sand & Gravel, North Dumfries; Drew's first stop |
| 9999-990006 | PitBlk with no pit named yet |
| 9999-990007, 990008 | a slinger / tri-axle charge, no date, on no Deliveries report |
| 9999-990010 | Demo Pavers PO delivery; Drew's second stop |
| 9999-990011, 990012 | two Demo Aggregates POs on one brokered trip (Casey), $145/load |
| 9999-990013 | a load with carrier Demo Haulage and no rate |
| 9999-990020-23 | ordinary yard deliveries (990021 delivered this morning) |
| 9999-990030 | in yesterday's and today's upload; quantity and instruction changed |
| 9999-990040 | on the Deliveries report with no phone |
| 9999-990041 | a yard pickup with no phone |
| 9999-990050 | due yesterday, never sent: Carried over |
| 9999-990051-54 | yesterday's finished deliveries, with the drivers' tickets |
| 9999-990060 | due tomorrow |

Invoices: DP-5001 (Demo Pavers, PDF, with an Excel load breakdown beside it),
DA-8801 (Demo Aggregates, an .xlsx invoice), DH-301 (Demo Haulage, trucking).
Their verdicts were made by the matching engine, not written by hand.

**Files are not real.** Invoices, tickets and delivery photos point at
`/uploads/demo/...` paths that do not exist, so every preview and download
shows as missing (404) locally. That is expected.

## 7. Click-through, by client answer

Log in as `admin@demo.invalid` unless the step says otherwise.

**A1. FOB + supplier = the customer collects.**
- Dispatch board, today: 9999-990001 is not on it, though it is dated today.
- Orders page: 9999-990001 says "Pickup at Examplestone…" (Ayr), not "No driver yet".
- Dispatch board: 9999-990002 is on Dana's run, its route line saying to load
  at Examplestone, Ayr, PO 9999-880002. Open it in the order editor: the type
  is "Delivery via supplier", set by dispatch.
- Log in as `driver1@demo.invalid` (`/login/driver`): Dana's current stop is
  9999-990002 with "Pick up first: Examplestone, Ayr, 12 Demo Quarry Rd, PO
  9999-880002". No prices anywhere.

**A2. Supplier delivery wording.** Today's pool: 9999-990003 is there (not
hidden), with "Supplier delivery mentioned: confirm".

**A3. Quotations.** 9999-990004 is on no part of the board. Orders page:
hidden by default; Show → Quotations lists it, labelled Quotation. (An
upload's summary also says how many quotations it left out; the seed imports
already-read reports, so that summary is only on the stored batch, not on
screen. Upload any report to see one.)

**A4. A PO means we collect at the supplier.** Drew's second stop,
9999-990010, loads at Demo Pavers Inc., Cambridge. Casey Broker's run has
9999-990011 and 9999-990012: both loads carry trip DEMO-TRIP-TODAY, carrier
Demo Haulage, $145.00 / load, and say the trip serves both orders.

**A5. PitBlk.** Drew's first stop, 9999-990005, names the pit dispatch chose
(Sample Sand & Gravel, North Dumfries, with its address); as `driver2` it is
the phone's "Pick up first". 9999-990006 in the pool has no pit yet and says so.

**A6. Charge-only deliveries.** Today's pool has a collapsed group "Likely
already delivered (not on today's Deliveries report)" holding 9999-990007 and
9999-990008, each with "Not on a Deliveries report: likely delivered already".
"Done outside the app" marks one delivered and it leaves the board (re-run the
seed to put it back).

**A7. Re-imported reports.** 9999-990030 is in the pool marked Updated
(quantity 10 → 12, instruction, phone). It has one set of lines although two
uploads carried it. Carried over shows 9999-990050 from yesterday.

**A8. Phones.** Orders page, Missing → Phone: only 9999-990040. The yard
pickup 9999-990041 has no phone either and is not listed or flagged.

**A9-A11. The inbox.** Invoices page, "Unrecognised senders": an email from
`invoices@unknown-supplier.example` waiting for approval (approve or ignore as
`owner@demo.invalid`; as `ap@demo.invalid` you may only look), and one ignored
email in the ignored count. Nothing is polled: Gmail is off.

**A12. Excel.** Invoice DA-8801 is an .xlsx: its page offers the file as a
download instead of a preview. DP-5001 lists DP-5001-load-breakdown.xlsx as a
supporting file. The unrecognised-senders queue also holds DA-8790.xls with
"old Excel format (.xls): ask the supplier for PDF or .xlsx". A monthly
statement from Demo Aggregates was recorded in the mailbox log and made no
invoice: the Invoices list has only the three invoices above.

**A14. Rates.** Rates page: Demo Pavers has a price list whose products carry
Spruce item codes (DPCHAR60, DPSAND) and supplier codes. Invoice DP-5001:
line 1 passes, its rate "found by item code DPCHAR60" because the price list
words the product differently; line 2 is a rate mismatch (31.00 billed, 28.50
agreed). DA-8801's lines match. On the board, 9999-990013 shows "No haul
rate"; set a rate on its load and the badge goes. DH-301 is Demo Haulage's
bill for yesterday's hauls, one line per ticket with the day it ran, each
checked against the load dispatch recorded. Lines 1 and 2 (DH-1101, DH-1102)
bill the two loads of brokered trip DEMO-TRIP-YESTERDAY (9999-990053 and
990054) one load at a time: each passes at the $140/load dispatch set and
counts only the load its ticket names, so confirming line 1 leaves line 2
free to be paid. Line 3 (DH-1103, a second sand load) bills $160 where
dispatch agreed $150, a rate mismatch approved at $150; line 4 (DH-1104, a
second gravel load) says "No haul rate set" because nobody priced that load.
Set a rate on it (9999-990054, load 2) and line 4 is checked again on its own.

**A15. Emailed tickets.** Tickets page: DP-70001 (Drew's photo, MANUAL) and
"DP 70001" (EMAIL: the copy Demo Pavers attached to its invoice email). The
emailed one is stored as a second copy of the driver's. On DP-5001 line 1 the
load is counted once (300 SQFT, not 600), and the "Two copies of a ticket"
check says the copies agree.

## 8. Clean up

```sh
docker rm -f cgc-demo-db
```

or drop `cgc_demo` from the shared container. Nothing outside it was written.
