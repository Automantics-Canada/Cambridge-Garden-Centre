#CGC

# Cambridge Garden Centre - AP Verification System

## Overview
The CGC AP Verification System automates the ingestion, matching, and verification of Accounts Payable (AP) documents. It provides an end-to-end pipeline that handles order creation, ticket OCR parsing and matching, and invoice ingestion via email to reduce manual AP input and ensure pricing accuracy.

---

## Data Flow & Architecture

The system operates across three main data entities:
1. **Orders**: Originating from the Spruce ERP system (via direct CSV upload).
2. **Tickets**: Originating from supply drivers arriving physically at sites. They send photos of tickets via WhatsApp or Email.
3. **Invoices**: Arriving from the suppliers, typically directly via the AP email inbox (`ap@cambridgegardencentre.ca`).

### End-to-End Workflow

**1. Order Ingestion (Spruce -> Database)**
- **User Action:** The manager or AP staff exports the order list from Spruce as a CSV file and uploads it into the CGC Dashboard under "Orders".
- **System Action:** parses the CSV and creates `Order` records. Duplicate SP ID rows trigger updates rather than errors.

**2. Ticket Arrival & OCR**
- **User Action:** A driver sends a photo of a material ticket.
- **System Action:** A webhook or email puller grabs the raw image, queues an `OcrJob`, and dispatches it to AWS Textract (`DetectDocumentText`).
- **System Action:** A deterministic parser reads PO number, ticket number, supplier, material, date and net quantity out of the OCR text. Each field is validated and carries its own confidence — see *Document extraction* below.

**3. Auto-Linking Engine**
- **System Action:** After OCR extraction, the backend matches the extracted `poNumber` against existing `Orders`.
- If exactly 1 match occurs, the ticket is marked as `LINKED` and associated directly.
- If no match occurs or the PO number was illegible, the ticket enters the `UNLINKED` queue awaiting manual AP review.

**4. Invoice Arrival & Matching**
- **User Action:** Supplier emails a PDF invoice to AP.
- **System Action:** The Gmail API Integration (or Mock Endpoint) receives the email, downloads the attachment, and generates an `Invoice` record.
- **System Action:** AWS Textract (`AnalyzeExpense`) parses the invoice, and the deterministic extractor reads its structured summary fields and line item groups into typed, validated fields.
- **Matching Engine:** The system checks the extracted line items against:
  - Linked Orders
  - Negotiated Supplier Rates table
- If discrepancies exist (e.g. rate mismatch), the Line Item is tagged with a `LineItemFlag` (e.g. `RATE_MISMATCH`).

**5. AP Dashboard Verification**
- **User Action:** The AP user opens the "Invoices" tab in the frontend dashboard.
- The user clicks "Review" on a pending invoice.
- A side-by-side modal opens: showing the raw PDF on the left and extracted data/flagged items on the right.
- The AP user clicks **Verify** or **Dispute**.
- **System Action:** The system updates the invoice state and permanently records the action in the `AuditLog` table ensuring accountability.

---

## Document extraction

Textract is the OCR provider. What turns its output into fields is deterministic
code, and a language model is reached for only to fill gaps.

```
Document
  -> AWS Textract                     (OCR: AnalyzeExpense or DetectDocumentText)
  -> deterministic extraction         (typed fields, per-field confidence)
  -> field-level validation           (dates, units, six-digit POs, CAD amounts, arithmetic)
  -> fallback reader                  (only for fields still missing or uncertain)
  -> deterministic merge + recheck
  -> persist, or mark NEEDS_REVIEW
```

The rules that matter:

- **Nothing is defaulted.** A unit that cannot be read stays empty; it does not
  become `ea`. A price that cannot be read stays empty; it does not become `0`.
- **The fallback fills, it does not overrule.** A field that validated at high
  confidence is never offered to the model and can never be overwritten by it.
- **Model output is a candidate.** It is returned as text and put through the
  same validators as anything Textract produced. Anything that fails is dropped.
- **A fallback-sourced value always reaches a person.** Any document that used it
  finishes `NEEDS_REVIEW`, never `COMPLETED`.
- **OCR cannot create or guess a supplier.** Only an exact name or email-domain
  match attaches one. A close match is shown as a suggestion and links nothing.
- **Invoice writes are transactional.** The header and the complete set of line
  items are replaced together or not at all.

### OCR job states

| State | Meaning |
| --- | --- |
| `COMPLETED` | Every required field validated. Nothing came from the fallback. |
| `NEEDS_REVIEW` | A usable result exists, but a field is unresolved, was read with low confidence, or came from the fallback. Terminal — it is never retried. |
| `FAILED` | No usable result at all (unreadable file, no text detected). Retried with backoff up to `MAX_OCR_ATTEMPTS`. |

### Environment

Backend and worker only. **None of these belong in the frontend or in Vercel** —
the frontend build is public.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` | — | Textract. Required; OCR does not run without them. |
| `GROQ_API_KEY` | _(unset)_ | Fallback reader credential. **Optional** — the API and worker start without it. |
| `GROQ_MODEL` | `openai/gpt-oss-20b` | Fallback model. |
| `GROQ_FALLBACK_ENABLED` | `false` | Must be `true` for any fallback call to happen. A key on its own does not enable it. |
| `GROQ_TIMEOUT_MS` | `20000` | Per-request timeout. |
| `GROQ_MAX_OUTPUT_TOKENS` | `1200` | Bounded output. |
| `GROQ_MAX_CONCURRENCY` | `2` | Ceiling on simultaneous fallback calls per worker. |

With `GROQ_FALLBACK_ENABLED` unset or `false`, the system runs deterministically:
documents that cannot be fully read are marked `NEEDS_REVIEW` rather than
completed. That is a supported operating mode, not a degraded one.

### What is sent to the fallback, and what is logged

Sent: the list of unresolved field names and only the matching OCR line
neighbourhoods, with contact/address patterns stripped and the total length
bounded. Not sent: unrelated document sections, the Textract response, file
URLs, images, or any database identifier.

Logged: job id, document type, model, duration, token counts, and outcome.
Never logged: prompts, OCR text, model output, API keys, or document values.

> **Rollout prerequisite.** Groq Zero Data Retention must be confirmed on the
> account before the fallback is enabled against real supplier documents. It is
> not asserted here and cannot be verified from this repository.

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
│   │   ├── services/       # File storage, AWS Textract, and documentExtraction/
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

## How to Test the Entire System 
*(Micro & Detailed Steps)*

### 1. Prerequisites setup
1. Ensure Postgres DB is running and Prisma URL is injected into `.env`.
2. Ensure you have valid `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_REGION` configured either locally or in `.env` for Textract to work. The Groq fallback is optional and off by default — see *Document extraction*.
3. Start Backend: `cd backend && npm run dev`
4. Start Frontend: `cd frontend && npm run dev`

### 2. Prepare Base Data
1. Navigate to the frontend (e.g., `http://localhost:5173`). Login using your test `ADMIN` credentials.
2. In your backend or DB viewer, create a mock `Supplier`. Take note of the `id`. Add a `NegotiatedRate` object for this supplier targeting product `"Gravel"` with rate `15.00`.
3. Create a test Spruce CSV (or use existing `sample_orders_3.csv`) containing an order with `poNumber` = `PO-9999` attached to the supplier.
4. Upload the Spruce CSV via Postman `POST /api/order/import` or the frontend if available.

### 3. Test Ticket Auto-Linking (Step 4)
1. In Postman, simulate a driver ticket upload hitting `POST /api/ticket/whatsapp` (with an image `file` in form-data). Ensure the image contains the text `"PO-9999"`.
2. Inspect the returned Ticket payload or check the PostgreSQL DB `Ticket` table.
3. **Verify:** You should see `status: "LINKED"` and `linkedOrderId` successfully populated automatically.

### 4. Test Invoice Ingestion & OCR Match (Steps 5 & 6)
1. In Postman, invoke the Mock Email Endpoint:
   - **Method:** `POST http://localhost:8080/api/invoice/mock-email`
   - **Body (form-data):**
     - `file`: Attach a visual mock Invoice PDF.
     - `fromEmail`: `billing@mocksupplier.com`
     - `subject`: `Invoice #12345 Attached`
2. Wait 5-10 seconds for Textract to finish processing background OCR.
3. Send a `GET http://localhost:8080/api/invoice` request.
4. **Verify:** The new invoice shows `STATUS = PENDING_REVIEW`. Inspect the `lineItems` property. The matching engine should have assigned `RATE_MISMATCH`, `OK`, or `NO_ORDER` depending on what Textract detected vs your Negotiated Rate.

### 5. Test the Frontend AP Dashboard (Steps 7 & 8)
1. Go to the web UI dashboard and click **Invoices** in the sidebar.
2. You will see your newly uploaded invoice in the table.
3. Click the **Review** (eye) icon button on the right side.
4. A large modal will appear:
   - On the left, the raw PDF is rendered.
   - On the right, extrapolated data points and analyzed mismatched flags.
5. Provide a dispute reasoning in the text area at the bottom right.
6. Click **Dispute**.
7. Modal closes, and the table dynamically updates the status to `DISPUTED`.
8. Check the PostgreSQL `AuditLog` table: `SELECT * FROM "AuditLog";`
   - **Verify:** A permanent timestamped audit trail was generated for the dispute action.
