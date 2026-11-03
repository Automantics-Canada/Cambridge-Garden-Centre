#CGC

# Cambridge Garden Centre - AP Verification System

## Overview
The CGC AP Verification System automates the ingestion, matching, and verification of Accounts Payable (AP) documents. It provides an end-to-end pipeline that handles order creation, ticket OCR parsing and matching, and invoice ingestion via email to reduce manual AP input and ensure pricing accuracy.

---

## Data Flow

1. **Orders (Spruce → app).** Each morning the office uploads the Spruce PDF reports
   (Order report / Order Summary, Deliveries report, Item Tracking report) on the
   Orders page. The import classifies every order as Pickup, Delivery, Delivery via
   supplier, Supplier pickup or Direct ship and stores the result as order documents.
2. **Dispatch.** Deliveries go on the dispatch board; assigned stops appear on the
   driver's phone. Drivers never see prices, costs or rates.
3. **Tickets.** Drivers photograph the material ticket at each stop. The photo is
   stored and an `OcrJob` is queued; the worker reads it with the OpenAI extraction
   model (PO, ticket number, supplier, material, date, quantity).
4. **Invoices (email → app).** Suppliers email invoices to
   `ap@cambridgegardencentre.ca` (Microsoft 365). M365 forwards them to a Gmail
   inbox, where a filter applies the invoice label. The worker polls that label
   every minute (`src/services/gmail.service.ts`), works out the original sender
   even through a forward, and looks it up in the supplier records (email domains
   and exact addresses; `src/services/knownSenders.ts`). Each of a known sender's
   attachments is sorted page by page first (`src/services/emailTriage.ts`):
   invoice pages become one `PENDING_REVIEW` invoice, delivery ticket pages
   become emailed tickets, statements are recorded and not billed. PDF, image,
   `.xlsx` and `.csv` invoices are read; an Excel beside a PDF invoice is kept
   with it as a supporting file. Mail from an unknown sender, or carrying a credit
   memo, an old `.xls` or another file the app cannot read, waits under
   "Unrecognised senders" on the Invoices page, where an owner or admin approves
   the sender or ignores the email. Setup and go-live:
   `CGC/backend/docs/gmail-mailbox-switch.md`.
5. **Matching.** OCR reads the invoice lines; the matching engine links invoice →
   ticket → order and checks quantities and agreed rates, flagging each line. The
   driver's photo and the supplier's emailed copy of one ticket count as one load
   (`src/modules/tickets/ticketCopies.ts`); a line backed only by the supplier's
   own copies waits for AP.
6. **AP review.** On the Invoices page AP staff review the flagged lines next to the
   PDF and verify or dispute; every decision is written to the `AuditLog`.

`GET /api/health` reports the API build, whether the background worker is alive and
on the same build, and what the Gmail poller last did.

---

## Folder Structure

```
├── backend/
│   ├── prisma/             # Database schemas & migrations
│   ├── src/
│   │   ├── modules/
│   │   │   ├── auth/       # Authentication
│   │   │   ├── invoices/   # Invoice endpoints, logic & OCR processing
│   │   │   ├── orders/     # Order ingestion logic
│   │   │   ├── supplier/   # Supplier logic
│   │   │   └── tickets/    # Ticket ingestion, Auto-linking & OCR logic 
│   │   ├── services/       # File storage, extraction (OpenAI), Gmail poller
│   │   ├── middleware/     # Express route JWT protection
│   │   └── app.ts          # Core router pipeline
├── frontend/
│   └── src/
│       ├── components/     # UI
│       ├── layouts/        # Dashboard layout shells
│       ├── pages/          
│       │   └── dashboard/  # Invoices, Orders, Suppliers, Tickets
│       └── store/          # Redux toolkit
```

---

## Running and Testing

Backend (`CGC/backend`): `npm run dev` (API), `npm run dev:worker` (pollers and OCR),
`npm test` (unit tests, no database). Integration tests delete every row, so they only
run against a disposable loopback database:
`CGC_TEST_CONFIRM_DISPOSABLE=1 DATABASE_URL=... DIRECT_URL=... npm run test:integration`.

Frontend (`CGC/frontend`, Node 22): `npm run dev`, `npm run lint`, `npx vitest run`.
