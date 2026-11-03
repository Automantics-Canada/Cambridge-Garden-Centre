/**
 * What the model is told about CGC's paperwork.
 *
 * These carry the domain rules the old Bedrock prompts had learned the hard
 * way, and they are the reason those prompts are worth keeping rather than
 * rewriting: "Cambridge Garden Centre" appears on every document as the *buyer*
 * and was repeatedly extracted as the supplier; PO numbers are exactly six
 * digits; invoice lines print their unit somewhere other than beside the
 * quantity, and a missing unit meant a line could not be checked against a
 * ticket at all.
 *
 * What is deliberately gone is the "return ONLY valid JSON, no explanations"
 * boilerplate. The provider's structured-output mode guarantees the shape now,
 * so the prompt only has to describe the *document*.
 *
 * The model reads the image or PDF directly here. It is no longer working from
 * a flattened list of text lines, so it can be asked about layout — which
 * column a number sits in, which company is at the top of the page.
 */

const SHARED_RULES = `
You are reading a document for Cambridge Garden Centre (CGC), a landscaping
supply yard in Ontario.

Rules that apply to every field:
- "Cambridge Garden Centre" is the CUSTOMER being billed. It is never the
  supplier. The supplier is the company that issued the document, normally
  printed at the top of the page (for example "Dufferin Aggregates").
- A PO number is exactly six digits, e.g. 123456. If what you can see is not
  six digits, return what is printed and name "poNumber" in uncertainFields.
- Report only what the document shows. If a field is not present, return null.
  Never infer a plausible value, and never copy a value from a different field
  to fill a gap. A null costs someone a minute; an invented number can pay a
  supplier for material that was never delivered.
- Set readability to how legible the document is overall: "clear", or
  "partly_legible" when parts are blurred, cut off or handwritten, or "poor"
  when much of it cannot be made out.
- List in uncertainFields the name of every field whose value you are not
  confident in. Still return your best reading of those fields.
`.trim();

/**
 * Delivery (scale) tickets: photographed by drivers in a truck cab, often
 * creased, sometimes carbon copies. Quantity and PO are the two fields the
 * verification desk actually depends on.
 */
export const TICKET_PROMPT = `
${SHARED_RULES}

This document is a delivery ticket (a scale ticket) for one truckload.

Extract:
- supplierName: the company that issued the ticket, not CGC.
- date: the ticket date, as YYYY-MM-DD.
- ticketNumber: the ticket or reference number printed on it.
- poNumber: the six-digit purchase order number.
- material: what was carried, as written (e.g. "A Gravel", "Screened Sand").
- quantity: the numeric amount only, with no unit text.
- unit: the unit shown beside that quantity (tons, tonnes, cy, each, ...),
  exactly as the ticket words it.

Scale tickets often print gross, tare and net weights together. The quantity
that matters is the NET weight — what was actually delivered.
`.trim();

/**
 * Supplier invoices: arrive as emailed PDFs. Line-level PO numbers are what
 * later lets a line be checked against an order and its tickets, so they are
 * worth reading even when they repeat the header PO.
 */
export const INVOICE_PROMPT = `
${SHARED_RULES}

This document is a supplier invoice.

Extract:
- supplierName: the company issuing the invoice, not CGC.
- invoiceNumber: the invoice's own identifier.
- date: the invoice date, as YYYY-MM-DD.
- poNumber: the header-level six-digit purchase order number, if one is shown.
- totalAmount: the invoice total as a number, without a currency symbol.
- lineItems: every charged line on the invoice, including delivery and fuel
  charges. For each line:
  - description: the full text of the line as printed.
  - quantity, unitPrice, totalPrice: numbers only.
  - unit: the unit of measure for that line. It is frequently printed in its
    own column, or appended to the description, rather than next to the
    quantity — look for it in all of those places before returning null. A line
    without a unit cannot be checked against a delivery ticket.
  - poNumber: the PO for that specific line. Extract it for every line, even
    when it repeats the header PO. On a trucking invoice this column may be
    headed "PO", "Job" or "Order"; read whichever number it prints.
  - ticketNumber: the ticket or load number printed on that line, as printed.
    Trucking (hauling) invoices list one line per load or per trip, each with
    a date, a ticket or load number, a PO or job, the hours, tonnes or loads,
    a rate and an amount. Null when the line shows none, as on most material
    invoices.
  - serviceDate: the date printed on that line for when the load or trip was
    hauled, as YYYY-MM-DD. Null when the line shows no date of its own; never
    copy the invoice date into it.

Suppliers sometimes attach other paperwork to the same file. Read only the
invoice itself:
- Ignore delivery or scale ticket pages (one truckload each, with a ticket
  number and gross/tare/net weights). Never list a ticket as an invoice line;
  the tickets are checked separately.
- Ignore account statements (a list of earlier invoices with balances owing)
  and remittance slips. Never list an earlier invoice as a line.

The document may arrive as text instead of a page: a spreadsheet, one row per
line with cells separated by tabs, and "# Sheet:" before each sheet. Read it
the same way. A sheet that only breaks loads down (ticket numbers and weights)
is supporting detail, not extra lines.
`.trim();

/**
 * Sorting an emailed attachment before anything is created from it.
 *
 * The inbox used to make every attachment an invoice. A ticket attached to the
 * invoice email (A15) became a second "invoice" that billed the same PO, and a
 * statement re-billed every invoice it listed. One cheap call says what each
 * page is, so invoice pages become an invoice, ticket pages become tickets, and
 * statements and credit memos are recorded without being billed.
 */
export const TRIAGE_PROMPT = `
You are sorting paperwork that a supplier emailed to Cambridge Garden Centre
(CGC), a landscaping supply yard in Ontario. CGC is the customer.

Say what each page is. Use exactly one kind per page:
- "invoice": a bill to CGC with charges and a total due. Every page of a
  multi-page invoice is "invoice", including a page that only continues its
  lines or shows its totals.
- "delivery_ticket": a delivery, weigh or scale ticket for one truckload: a
  ticket number, a truck, gross/tare/net weights or a quantity delivered, often
  signed. A page listing many loads with their ticket numbers as part of an
  invoice is still "invoice".
- "statement": an account statement listing several invoices and the balance
  owing, or a remittance slip.
- "credit_memo": a credit note or credit memo: money the supplier owes CGC.
- "other": anything else, such as a cover letter, terms and conditions, a
  price list, a blank page or a logo.

Number the pages from 1 in the order they appear, and return one entry for
every page. A single photo or image is page 1. A document given as text (a
spreadsheet) is page 1. When you cannot tell, say "other": a person will look.
`.trim();
