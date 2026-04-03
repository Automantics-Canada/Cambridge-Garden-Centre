# Cambridge Garden Centre - AP Verification System

## Overview
The CGC AP Verification System automates the ingestion, matching, and verification of Accounts Payable (AP) documents. It provides an end-to-end pipeline that handles order creation, ticket OCR parsing and auto-linking, supplier rate management, and invoice discrepancy auditing.

---

## Testing Guide (Postman & Frontend)

To test the APIs via Postman, you must pass the `Authorization: Bearer <TOKEN>` header obtained from the Login endpoint to access protected routes (any route except login/register/mock webhooks).

### 1. Authentication Endpoints

#### Register
- **Endpoint:** `POST /api/auth/register`
- **Frontend Action:** Submit the Register form under `/register`.
- **Example JSON Input:**
  ```json
  {
    "name": "Jane Doe",
    "email": "jane@cgc.com",
    "password": "SecurePassword123!",
    "role": "ADMIN"
  }
  ```
- **Expected Output:** `201 Created` with a user object and JWT token.

#### Login
- **Endpoint:** `POST /api/auth/login`
- **Frontend Action:** Submit the Login form under `/login`.
- **Example JSON Input:**
  ```json
  {
    "email": "jane@cgc.com",
    "password": "SecurePassword123!"
  }
  ```
- **Expected Output:** `200 OK` with user profile and `token`.

---

### 2. Supplier & Negotiated Rates Endpoints

#### Create Supplier
- **Endpoint:** `POST /api/supplier`
- **Frontend Action:** Click `Add Supplier` button on the Suppliers dashboard and fill the form.
- **Example JSON Input:**
  ```json
  {
    "name": "Aggregates R Us",
    "type": "SUPPLIER",
    "emailDomains": ["aggregatesrus.com"],
    "contactEmail": "billing@aggregatesrus.com",
    "phone": "555-1234"
  }
  ```
- **Expected Output:** `201 Created` returning the new Supplier object including its generated UUID.

#### Get Suppliers
- **Endpoint:** `GET /api/supplier`
- **Frontend Action:** Navigate to the Suppliers dashboard.
- **Expected Output:** `200 OK` returning an array of all active suppliers along with their nested `negotiatedRates`.

#### Update Supplier
- **Endpoint:** `PUT /api/supplier/:id`
- **Frontend Action:** Click Edit on a Supplier row and submit the form.
- **Example JSON Input:**
  ```json
  {
    "phone": "555-9999"
  }
  ```
- **Expected Output:** `200 OK` returning the updated Supplier object.

#### Delete Supplier
- **Endpoint:** `DELETE /api/supplier/:id`
- **Frontend Action:** Click the Trash icon on a Supplier row and confirm.
- **Expected Output:** `200 OK` returning the supplier with `active: false`.

#### Add Negotiated Rate
- **Endpoint:** `POST /api/supplier/:id/rates`
- **Frontend Action:** In the Supplier Edit modal, fill the "Add New Rate" inputs and click 'Add Rate'.
- **Example JSON Input:**
  ```json
  {
    "productName": "Gravel 3/4 Clear",
    "rate": 15.50,
    "unit": "ton",
    "effectiveFrom": "2026-01-01",
    "notes": "Spring pricing"
  }
  ```
- **Expected Output:** `201 Created` returning the new `NegotiatedRate` object.

#### Delete Negotiated Rate
- **Endpoint:** `DELETE /api/supplier/:id/rates/:rateId`
- **Frontend Action:** In the Supplier Edit modal's rates table, click 'Remove' next to a rate.
- **Expected Output:** `200 OK` with `{ "success": true }`.

---

### 3. Orders Endpoints

#### Import Spruce Orders
- **Endpoint:** `POST /api/order/import`
- **Frontend Action:** Not fully mapped yet (usually a form file upload).
- **Postman Setup:** Select `Body` -> `form-data`. Key: `file` (type File, select your `sample_orders.csv`).
- **Expected Output:** `200 OK` with an `ImportSummary` detailing `created`, `updated`, `skipped`, and `errors`.

#### Get Orders
- **Endpoint:** `GET /api/order`
- **Wait/Filter Params:** `?search=PO-1234&hasInvoice=yes`
- **Frontend Action:** Navigate to Dashboard -> Orders. Filters apply directly from UI.
- **Expected Output:** `200 OK` returning an array of `Order` records mapped against their supplier.

---

### 4. Tickets Endpoints

#### Ingest WhatsApp Ticket
- **Endpoint:** `POST /api/ticket/whatsapp`
- **Postman Setup:** Select `Body` -> `form-data`. Key: `file` (File), Key: `fromPhone` (Text, e.g. `555-1234`).
- **Expected Output:** `200 OK` returning created `ticket` (Status: UNLINKED) and `ocrJob`. (Background process attempts to Auto-Link to an Order via PO matched).

#### Ingest Email Ticket
- **Endpoint:** `POST /api/ticket/email`
- **Postman Setup:** Select `Body` -> `form-data`. Key: `file` (File), Key: `fromEmail` (Text, e.g. `driver@logistics.com`).
- **Expected Output:** `200 OK` returning created `ticket` and `ocrJob`.

#### Get & Update Tickets
- **Endpoint:** `GET /api/ticket` & `GET /api/ticket/:id`
- **Endpoint:** `PUT /api/ticket/:id` (Input: manual override JSON)
- **Endpoint:** `DELETE /api/ticket/:id`
- **Expected Output:** `200 OK` Standard CRUD operations.

---

### 5. Invoices Endpoints

#### Mock Email Ingestion (Simulate receiving an invoice)
- **Endpoint:** `POST /api/invoice/mock-email`
- **Postman Setup:** Select `Body` -> `form-data`. Key: `file` (File, select `.pdf` or image invoice), Key: `fromEmail` (Text, e.g. `billing@aggregatesrus.com`), Key: `subject` (Text, e.g. `Invoice Attached`).
- **Expected Output:** `202 Accepted` returning `invoice` (Status: PENDING_REVIEW). The system automatically dispatches an AWS Textract `AnalyzeExpense` job to read line items and match against Negotiated Rates and Orders.

#### Get Invoices
- **Endpoint:** `GET /api/invoice`
- **Frontend Action:** Navigate to Dashboard -> Invoices. Table auto-loads all invoices.
- **Expected Output:** `200 OK` returning an array of Invoice data including nested `verifiedBy` and `supplier` records.

#### Get Invoice by ID
- **Endpoint:** `GET /api/invoice/:id`
- **Frontend Action:** Clicking "Review" on an invoice row fetches this data representing the document PDF and all extracted line items.
- **Expected Output:** `200 OK` returning deep invoice records including nested `lineItems` with `flag` calculations (`RATE_MISMATCH`, `OK`, etc.).

#### Verify Invoice
- **Endpoint:** `POST /api/invoice/:id/verify`
- **Frontend Action:** Clicking the generic 'Verify' button in the side-by-side Review Modal.
- **Expected Output:** `200 OK` returning the Invoice mapped to Status `VERIFIED`. (Also transparently writes to `AuditLog` table securely).

#### Dispute Invoice
- **Endpoint:** `POST /api/invoice/:id/dispute`
- **Frontend Action:** Fill out the Dispute reasoning box in the modal and hit 'Dispute'.
- **Example JSON Input:**
  ```json
  {
    "note": "We were charged $18/ton but the negotiated rate was $15.50/ton."
  }
  ```
- **Expected Output:** `200 OK` returning the Invoice mapped to Status `DISPUTED`. Writes the dispute note to `AuditLog`.
