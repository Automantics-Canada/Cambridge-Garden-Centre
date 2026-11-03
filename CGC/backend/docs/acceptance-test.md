# Client answers acceptance test

`tests/clientAnswers.acceptance.integration.test.ts` checks, end to end, that
the app does what each of the client's fifteen answers (Oct 2026) asks. It is
one fictional day at the yard, driven the way the app is used: the morning
Spruce reports go through the real import, the office and the drivers work
through the HTTP API with their own logins, the invoice inbox is read by the
real poller, files go through the real storage and OCR code, and every
verdict comes from the real matching engine, against PostgreSQL.

Every name, number, address and amount in it is invented.

## Running it

It runs with the rest of the integration suite, against a disposable
loopback database only (it empties every table before and after):

```sh
cd CGC/backend
CGC_TEST_CONFIRM_DISPOSABLE=1 \
DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/disposable \
DIRECT_URL=postgresql://user:pass@127.0.0.1:5432/disposable \
npm run test:integration
```

or on its own:

```sh
CGC_TEST_CONFIRM_DISPOSABLE=1 DATABASE_URL=… DIRECT_URL=… \
  npx tsx --test tests/clientAnswers.acceptance.integration.test.ts
```

Without `CGC_TEST_CONFIRM_DISPOSABLE=1` and a loopback `DATABASE_URL` it skips.
It never needs a `.env`, a network connection, Gmail, Supabase or OpenAI.

## What is real and what stands in

| Part | In the test |
| --- | --- |
| Import, dispatch, orders, loads, rates, invoices, matching, email review queue | real code, real HTTP routes, real database |
| Spruce PDFs | already-read reports handed to the import service (`runImportBatch`), as the import route does once it has read them. pdf2json rejects PDFs a test can make; the PDF reading has its own parser tests. |
| Gmail | an in-memory mailbox behind `google.gmail`, as in `tests/gmailPoller.test.ts`. The Microsoft 365 forwarding rule (A10) is outside the app: the test delivers the message as Gmail receives it from ap@. |
| Supabase Storage | its HTTP calls answered in memory; downloads read back what was uploaded |
| OpenAI | a stand-in provider that answers each read with what the test sets, and records what it was sent |
| OCR | run when the test says (`WORKER_MODE=off`, then `processOcrJob`), never in the background |

The blocks share the day and run in order: A9 receives an invoice that A14
prices and whose emailed tickets A15 reads. They are a scenario; the edge
cases are in each package's own tests.

## What each block proves

**A1, FOB + supplier = the customer collects.** An order with an
"FOB FICTIONAL AYR" line imports as the customer's own collection: off the
pools, the board and the import's delivery counts, listed on the Orders page as
a pickup at Fictional. The office sets "Delivery via supplier" on the second
one: it joins today's board, and the driver's phone says to load at the FOB
yard (Ayr, with the supplier's Ayr address and the PO), not at CGC.

**A2, supplier delivery wording.** "Fictional Direct Delivery" leaves the
order on the board as CGC work with the check "Supplier delivery mentioned:
confirm". Only the office's "Direct ship" takes it off the board; it stays on
the Orders page.

**A3, quotations.** Item Tracking-only documents entered inside the Order
report's range are flagged QUOTE and named in the import summary instead of
counted. None is on today's board, the upcoming days' counts or the undated
list; assigning one is refused (409); the link pickers do not offer it, a hand
link from an invoice line is refused, an override of a verdict onto it is
refused (409), and the engine never offers its lines as candidates for a
ticket or an invoice line. The Orders page shows them only under Quotations (`quotes=only`).

**A4, a PO means CGC collects at the supplier.** The driver's "Pick up
first" names the supplier, its yard, the address on file and the PO; no
"check pickup point" flag is raised. Two POs go on one brokered (INDEPENDENT)
truck as one trip: the loads name the brokered driver and the board shows the
trip over both orders.

**A5, PitBlk.** With no pit named, the board asks for one and the driver is
told to ask dispatch (never sent to CGC's yard). Once dispatch names the pit,
the phone shows its name, location and address. On an order with a supplier
PO, dispatch's pit wins over the PO's vendor.

**A6, delivery charges.** Undated orders charged for a slinger or a tri-axle
and on no Deliveries report import as deliveries (SLINGER, DUMP), sit in the
board's "likely already delivered" group, and "Done outside the app" marks one
delivered with an audit row and takes it off the board. A driver is refused.

**A7, a wider Item Tracking range.** Yesterday's upload, this morning's and a
noon re-run with a 45-day range leave one order per document and one set of
lines (the later quantity). Month-old Item Tracking-only orders are read and
counted ("N read, M used") but never stored.

**A8, phones.** NO_PHONE is raised only for an order that has been on a
Deliveries report; the Orders page's "Missing: Phone" lists exactly that
order, not a pickup or an order not yet on a Deliveries report.

**A9-A11, the inbox.** An invoice forwarded by ap@ (a trusted forwarder whose
domain passes DKIM/SPF) is filed under the supplier who sent it, with the
supplier's address as the sender. An unknown sender's email waits in the
review queue with nothing downloaded; the AP desk can see the queue but not
approve (403); an owner approves the sender onto a supplier and the next poll
reads the email under that supplier. Observe mode records the email and
creates nothing.

**A12, Excel.** An .xlsx invoice reaches the same invoice reader as text
(every sheet, tab separated) and becomes an invoice with its lines. An old
.xls goes to a person with "ask for PDF or .xlsx". An Excel beside a PDF
invoice is kept as that invoice's supporting file and never read as a second
invoice.

**A13, samples.** The sample dry run in fixture mode reads and matches a
sample against `docs/invoice-samples/related.example.json`, and not a row in
any table, nor a stored file, changes.

**A14, rates.** A price list CSV is previewed (nothing saved) and then saved
whole; a material invoice line finds its agreed rate by the Spruce item code
although the price list words the product differently. Dispatch sets one rate
on the two loads of a brokered trip, $200 on another load, and leaves one load
unpriced. The carrier's invoice is checked per line: the line billing the
whole trip (two loads) passes at rate x quantity, the line 5% over is a rate mismatch approved at $200, the
unpriced load says "No haul rate set". Verifying is refused until every
finding is settled; dispatch then sets the missing rate (the waiting line is
re-checked by itself), AP accepts the over-billed line at the agreed rate, and
verifying claims all four loads. A second invoice for a paid load is
LOAD_ALREADY_CLAIMED.

**A15, emailed tickets.** The two ticket pages attached to the invoice email
become the supplier's copies. A line backed only by the supplier's own copy is
held for AP review. The driver photographs the other ticket on the phone; the
supplier's copy of it is linked to the driver's, and the invoice line counts
the load once (300, not 600) and passes.

**Throughout.** Every driver's current stop, run, profile and photo-upload
answer is checked for prices, costs, rates, carriers and supplier records,
including after loads with haul rates are recorded on their stops; the
office's routes refuse a driver.
