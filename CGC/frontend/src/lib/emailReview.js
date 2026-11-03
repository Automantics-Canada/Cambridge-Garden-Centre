/**
 * The "Unrecognised senders" panel on the Invoices page.
 *
 * The inbox poller keeps an email it cannot read automatically as a
 * NEEDS_REVIEW row (backend modules/emailEvents). Two kinds wait here:
 *
 *   sender     nobody in the supplier records sends from this address. The
 *              office approves it onto a supplier (and the email is read) or
 *              ignores it.
 *   manual     the sender is known but the email carries a spreadsheet the
 *              app cannot read (an old .xls), a credit memo, or nothing the
 *              app reads. Somebody enters it by hand, then ignores it here.
 *
 * Approving and ignoring are for owners and admins; AP staff see the list.
 */
import { domainOf, isFreeMailDomain } from './emailSenders';

const SENDER_REASONS = new Set(['UNKNOWN_SENDER', 'UNRESOLVED_SENDER']);
const MANAGER_ROLES = new Set(['OWNER', 'ADMIN']);

export const REVIEW_REASON_LABELS = {
  UNKNOWN_SENDER: 'Sender not in the supplier list',
  UNRESOLVED_SENDER: 'Forwarded, but the original sender could not be read',
  SPREADSHEET: 'Spreadsheet the app cannot read: enter by hand',
  CREDIT_MEMO: 'Credit memo: enter by hand',
  UNSUPPORTED_ATTACHMENTS: 'No attachment the app can read',
  NO_INVOICE_ATTACHMENT: 'No invoice attached',
  READ_FAILED: 'Could not be read after several tries: enter by hand',
  BEFORE_CUTOFF: 'Sent before the inbox went live: enter by hand if it is not in yet',
};

export function reviewReasonLabel(reason) {
  return REVIEW_REASON_LABELS[reason] ?? 'Needs a look';
}

/**
 * The error behind a READ_FAILED email, without the try count and time the
 * poller keeps in front of it ("Tried 6 times; last try …: the error").
 */
export function failureText(event) {
  if (event?.reviewReason !== 'READ_FAILED' || !event.errorMessage) return null;
  return String(event.errorMessage).replace(/^Tried \d+ times?; last try \S+: /, '');
}

/** Owners and admins approve and ignore; everyone else may only look. */
export function canManageQueue(role) {
  return MANAGER_ROLES.has(role);
}

/** Splits the queue into emails waiting on their sender and emails to enter by hand. */
export function splitQueue(events) {
  const senders = [];
  const manual = [];
  for (const event of events ?? []) {
    (SENDER_REASONS.has(event.reviewReason) ? senders : manual).push(event);
  }
  return { senders, manual };
}

/** Who the email is really from: the original sender, else the From address. */
export function senderOf(event) {
  return event?.originalFrom || event?.fromAddress || 'Unknown sender';
}

/**
 * What approving this email can add: its exact address always, its domain
 * only when the domain is not a shared mail service. Null when there is no
 * original sender to approve.
 */
export function approveOptions(event) {
  if (event?.reviewReason !== 'UNKNOWN_SENDER' || !event.originalFrom) return null;
  const address = event.originalFrom.toLowerCase();
  const domain = domainOf(address);
  return { address, domain, domainAllowed: Boolean(domain) && !isFreeMailDomain(domain) };
}

/** True when the email can still be approved or ignored from the panel. */
export function isActionable(event) {
  return event?.status === 'NEEDS_REVIEW' && !event.requeuedAt;
}

function formatSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What a file that was read became, when the poller did not say. */
function readOutcome(attachment) {
  if (attachment?.supportingInvoiceId) return 'kept with its invoice';
  const tickets = Array.isArray(attachment?.ticketIds) ? attachment.ticketIds.length : 0;
  if (attachment?.invoiceId && tickets > 0) {
    return `already an invoice in the list, and ${tickets} ticket${tickets === 1 ? '' : 's'}`;
  }
  if (tickets > 0) return `filed as ${tickets} ticket${tickets === 1 ? '' : 's'}`;
  return 'already an invoice in the list';
}

/**
 * "detail.xls · 24 KB · old Excel format (.xls): ask the supplier for PDF or .xlsx".
 *
 * A file that was read says so: an Excel invoice can arrive beside a PDF
 * that is already an invoice in the list, and entering both by hand would
 * bill it twice.
 */
export function describeAttachment(attachment) {
  const name = attachment?.name || '(no name)';
  const reason = attachment?.reason || (attachment?.action === 'read' ? readOutcome(attachment) : null);
  return [name, formatSize(attachment?.size), reason].filter(Boolean).join(' · ');
}

/**
 * The suppliers a sender can be approved onto. The "Unidentified supplier"
 * holding record is left out: the server refuses it, since a sender filed
 * under it would have every invoice read as nobody's.
 */
export function approveSupplierChoices(suppliers) {
  return (Array.isArray(suppliers) ? suppliers : [])
    .filter((s) => String(s?.name ?? '').trim().toLowerCase() !== 'unidentified supplier');
}

/** The attachments worth listing, most useful first: read, then waiting, then skipped. */
export function sortedAttachments(attachments) {
  const order = { read: 0, review: 1, held: 2, skipped: 3 };
  return [...(Array.isArray(attachments) ? attachments : [])]
    .sort((a, b) => (order[a.action] ?? 9) - (order[b.action] ?? 9));
}

/** The body for POST /api/email-events/:id/approve from the panel's form. */
export function approvePayload(form) {
  const match = form.match === 'domain' ? 'domain' : 'address';
  if (form.supplierId === 'NEW') {
    return { match, newSupplier: { name: String(form.newName ?? '').trim(), type: form.newType || 'SUPPLIER' } };
  }
  return { match, supplierId: form.supplierId };
}

/** Why the approve form cannot be sent yet, or null. */
export function approveFormError(form, options) {
  if (!form.supplierId) return 'Choose a supplier';
  if (form.supplierId === 'NEW' && !String(form.newName ?? '').trim()) return 'Name the new supplier';
  if (form.match === 'domain' && !options?.domainAllowed) return 'Approve the address: this domain is shared by many senders';
  return null;
}

/** What to tell the person after approving. */
export function approvedMessage(result) {
  const who = result?.added?.value ?? 'Sender';
  const supplier = result?.supplier?.name ?? 'the supplier';
  const count = result?.requeued ?? 0;
  const emails = count === 1 ? '1 email' : `${count} emails`;
  const older = result?.beforeCutoff ?? 0;
  const left = older === 0
    ? ''
    : ` ${older === 1 ? '1 older email was' : `${older} older emails were`} sent before the inbox went live and stay${older === 1 ? 's' : ''} under "Enter by hand".`;
  return `${who} added to ${supplier}. ${emails} will be read on the next inbox check.${left}`;
}
