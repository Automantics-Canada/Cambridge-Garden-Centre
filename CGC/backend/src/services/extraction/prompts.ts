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
    when it repeats the header PO.
`.trim();
