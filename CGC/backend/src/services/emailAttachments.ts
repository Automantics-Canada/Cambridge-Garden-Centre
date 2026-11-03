/**
 * Which parts of an email the invoice inbox reads, and why it leaves the rest.
 *
 * The poller used to keep a part only when its file name ended in .pdf, .jpg,
 * .jpeg or .png. That lost three kinds of mail without a word:
 *
 *   - a PDF whose name has no extension ("Invoice 1234"), which suppliers'
 *     billing systems do send;
 *   - Excel and CSV invoices (A12: "a small few attach an Excel"), which were
 *     dropped and the email marked done (.xlsx and .csv are now read; the
 *     old .xls format waits for a person);
 *   - nothing, in the other direction: Outlook's inline signature logos
 *     (image001.png) carry a file name, so each became a paid "invoice".
 *
 * Parts are now judged by MIME type and Content-ID first, then by their bytes
 * (the same magic-byte check the upload routes use), and every attachment
 * gets a line saying what happened to it. Nothing is skipped silently: the
 * caller stores these lines on the email's `EmailIngestionEvent`.
 *
 * Pure: no Gmail, no database.
 */
import type { gmail_v1 } from 'googleapis';
import { detectFileKind, sanitizeFilename } from '../middleware/uploadValidation.js';
import { detectSpreadsheetKind } from '../lib/spreadsheet.js';
import type { DocumentKind } from './extraction/schemas.js';

type Part = gmail_v1.Schema$MessagePart;

export type AttachmentKind = 'pdf' | 'image' | 'spreadsheet' | 'other';

/**
 * read      became an invoice, delivery tickets or a supporting file (or
 *           already had)
 * skipped   deliberately left out, with the reason
 * review    a person has to deal with it (the email goes to the review queue)
 * held      not looked at yet: the sender is not known, or observe mode
 */
export type AttachmentAction = 'read' | 'skipped' | 'review' | 'held';

export interface AttachmentRecord {
  name: string;
  mimeType: string | null;
  /** Bytes, as Gmail reports or as downloaded; null when unknown. */
  size: number | null;
  partId: string | null;
  kind: AttachmentKind;
  action: AttachmentAction;
  reason: string | null;
  /** The invoice this attachment became, when it did. */
  invoiceId?: string | null;
  /** What each page turned out to be, when the pages were sorted (emailTriage.ts). */
  pages?: Array<{ page: number; kind: DocumentKind }>;
  /** Delivery tickets filed from this attachment's ticket pages. */
  ticketIds?: string[];
  /** The invoice this file was kept beside, as a supporting file. */
  supportingInvoiceId?: string | null;
}

export const ATTACHMENT_REASONS = {
  inline: 'inline image (logo or signature)',
  tinyImage: 'image too small to be an invoice',
  legacyXls: 'old Excel format (.xls): ask the supplier for PDF or .xlsx',
  unreadableSheet: 'spreadsheet could not be read',
  supportingFile: 'kept with the invoice from this email as a supporting file',
  ticketFiled: 'delivery ticket: filed with the tickets',
  sheetOfLoads: 'a list of loads with no invoice beside it: enter by hand',
  statement: 'statement: recorded, not billed',
  creditMemo: 'credit memo: enter it by hand',
  notInvoice: 'not an invoice or a delivery ticket',
  sortFailed: 'pages could not be sorted, so the whole file was read as an invoice',
  unsupported: 'unsupported file type',
  heic: 'iPhone photo format (HEIC) the reader does not take; send it as JPG or PDF',
  mismatch: 'the file is not what its name or type says',
  held: 'waiting for the sender to be approved',
  observed: 'observe mode: nothing is read',
  duplicate: 'already read',
  readFailed: 'could not be read, after several tries',
  beforeCutoff: 'received before the inbox go-live date: not read',
} as const;

/**
 * Inline images at or under this size are taken for logos and signature
 * banners. A larger inline image may be a phone photo of an invoice pasted
 * into the email body, which must not be lost, so it is still read.
 */
export const INLINE_LOGO_MAX_BYTES = 100 * 1024;

/** No readable invoice photo or scan is this small; tracking pixels and icons are. */
export const MIN_IMAGE_BYTES = 8 * 1024;

const SPREADSHEET_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.ms-excel.sheet.macroenabled.12',
  'text/csv',
  'application/csv',
  'text/comma-separated-values',
]);
const SPREADSHEET_EXT = new Set(['xlsx', 'xlsm', 'xls', 'csv']);
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/gif', 'image/webp']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
/** Types that say nothing; the bytes decide. */
const VAGUE_MIME = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/x-download', 'application/download']);

function extensionOf(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match ? match[1]!.toLowerCase() : '';
}

function header(part: Part, name: string): string | null {
  const wanted = name.toLowerCase();
  return part.headers?.find(h => (h.name ?? '').toLowerCase() === wanted)?.value ?? null;
}

/** Every part of a message, depth first. */
export function allParts(payload: Part | undefined): Part[] {
  if (!payload) return [];
  return [payload, ...(payload.parts ?? []).flatMap(allParts)];
}

/**
 * Parts that are files rather than the message's own text: stored by
 * reference, and either named or of a type that is not a body type. A PDF
 * attached with no name at all is still a file.
 */
export function attachmentParts(payload: Part | undefined): Part[] {
  return allParts(payload).filter(part => {
    if (!part.body?.attachmentId) return false;
    if (part.filename) return true;
    const mime = (part.mimeType ?? '').toLowerCase();
    return !(mime.startsWith('text/') || mime.startsWith('multipart/') || mime.startsWith('message/'));
  });
}

export interface AttachmentCandidate {
  part: Part;
  record: AttachmentRecord;
  /** The bytes are needed to decide (and, for a PDF or image, to read it). */
  needsBytes: boolean;
}

/**
 * The first look, from what Gmail says about each part, before anything is
 * downloaded. PDFs, images, spreadsheets and files of no stated type need
 * their bytes; other files are decided here.
 */
export function triageAttachments(payload: Part | undefined): AttachmentCandidate[] {
  return attachmentParts(payload).map(part => {
    const name = part.filename ?? '';
    const mime = (part.mimeType ?? '').toLowerCase();
    const ext = extensionOf(name);
    const size = typeof part.body?.size === 'number' ? part.body.size : null;
    const base: AttachmentRecord = {
      name,
      mimeType: part.mimeType ?? null,
      size,
      partId: part.partId ?? null,
      kind: 'other',
      action: 'skipped',
      reason: null,
    };

    const isImage = IMAGE_MIME.has(mime) || mime.startsWith('image/') || IMAGE_EXT.has(ext);
    if (isImage) {
      const contentId = header(part, 'Content-ID') ?? header(part, 'X-Attachment-Id');
      const disposition = header(part, 'Content-Disposition') ?? '';
      const inline = Boolean(contentId) && !/^\s*attachment/i.test(disposition);
      if (inline && (size === null || size <= INLINE_LOGO_MAX_BYTES)) {
        return { part, record: { ...base, kind: 'image', reason: ATTACHMENT_REASONS.inline }, needsBytes: false };
      }
      if (size !== null && size < MIN_IMAGE_BYTES) {
        return { part, record: { ...base, kind: 'image', reason: ATTACHMENT_REASONS.tinyImage }, needsBytes: false };
      }
      if (mime === 'image/heic' || mime === 'image/heif' || ext === 'heic' || ext === 'heif') {
        return { part, record: { ...base, kind: 'image', reason: ATTACHMENT_REASONS.heic }, needsBytes: false };
      }
      return { part, record: { ...base, kind: 'image', action: 'read' }, needsBytes: true };
    }
    if (SPREADSHEET_MIME.has(mime) || SPREADSHEET_EXT.has(ext)) {
      // The bytes decide between .xlsx, CSV and the old .xls: Windows labels a
      // CSV application/vnd.ms-excel, and a file's name can say either.
      return { part, record: { ...base, kind: 'spreadsheet', action: 'read' }, needsBytes: true };
    }
    if (mime === 'application/pdf' || mime === 'application/x-pdf' || ext === 'pdf') {
      return { part, record: { ...base, kind: 'pdf', action: 'read' }, needsBytes: true };
    }
    if (VAGUE_MIME.has(mime) && (ext === '' || !/^(docx?|pptx?|zip|txt|html?|ics|eml|msg)$/.test(ext))) {
      // "Invoice 1234" sent as application/octet-stream: only the bytes say what it is.
      return { part, record: { ...base, kind: 'other', action: 'read' }, needsBytes: true };
    }
    return { part, record: { ...base, reason: ATTACHMENT_REASONS.unsupported }, needsBytes: false };
  });
}

/**
 * The decision once the bytes are in. A PDF or supported image is read
 * whatever it is called; an .xlsx, or a CSV sent as one, is read as a
 * spreadsheet; the old .xls format goes to review, because nothing here can
 * read it; anything else is listed as not read, with the reason.
 */
export function classifyDownloaded(record: AttachmentRecord, bytes: Buffer): AttachmentRecord {
  const sized = { ...record, size: bytes.length };
  const detected = detectFileKind(bytes);
  if (detected?.kind === 'pdf') return { ...sized, kind: 'pdf', action: 'read', reason: null };
  if (detected?.kind === 'image') {
    if (detected.label === 'HEIF/HEIC') return { ...sized, kind: 'image', action: 'skipped', reason: ATTACHMENT_REASONS.heic };
    if (bytes.length < MIN_IMAGE_BYTES) return { ...sized, kind: 'image', action: 'skipped', reason: ATTACHMENT_REASONS.tinyImage };
    return { ...sized, kind: 'image', action: 'read', reason: null };
  }
  // A workbook container is a spreadsheet whatever it was sent as. Plain text
  // is a CSV only when it was sent as one: a file of no stated type is not a
  // spreadsheet for being text.
  if (record.kind === 'other' || record.kind === 'spreadsheet') {
    const sheet = detectSpreadsheetKind(bytes, record.name || undefined);
    if (sheet === 'xls') {
      return { ...sized, kind: 'spreadsheet', action: 'review', reason: ATTACHMENT_REASONS.legacyXls };
    }
    if (sheet === 'xlsx' || (sheet === 'csv' && record.kind === 'spreadsheet')) {
      return { ...sized, kind: 'spreadsheet', action: 'read', reason: null };
    }
  }
  const claimed = record.kind === 'pdf' || record.kind === 'image' || record.kind === 'spreadsheet';
  return {
    ...sized,
    kind: 'other',
    action: 'skipped',
    reason: claimed ? ATTACHMENT_REASONS.mismatch : ATTACHMENT_REASONS.unsupported,
  };
}

const IMAGE_EXTENSION_BY_LABEL: Record<string, string> = { PNG: 'png', JPEG: 'jpg', GIF: 'gif', WebP: 'webp' };

/**
 * A safe stored name whose extension matches the bytes. Storage picks the
 * content type, and the reader the document type, from the extension, so an
 * unnamed PDF stored as "invoice" would be served and read as a JPEG.
 *
 * `kind` says the attachment was classified a spreadsheet: a CSV has no magic
 * bytes, so only that tells it from any other text.
 */
export function storedFileName(name: string, bytes: Buffer, kind?: AttachmentKind): string {
  const detected = detectFileKind(bytes);
  const sheet = kind === 'spreadsheet' ? detectSpreadsheetKind(bytes, name || undefined) : null;
  const wanted = detected?.kind === 'pdf'
    ? 'pdf'
    : sheet === 'xlsx' || sheet === 'csv'
      ? sheet
      : IMAGE_EXTENSION_BY_LABEL[detected?.label ?? ''];
  const safe = name ? sanitizeFilename(name) : 'invoice';
  if (!wanted) return safe;
  const ext = extensionOf(safe);
  if (ext === wanted || (wanted === 'jpg' && ext === 'jpeg')) return safe;
  return `${safe}.${wanted}`;
}

export type ReviewReason =
  /** Something was read, and another attachment needs a person (see below). */
  | 'PARTLY_READ'
  | 'UNKNOWN_SENDER'
  | 'UNRESOLVED_SENDER'
  | 'SPREADSHEET'
  | 'CREDIT_MEMO'
  | 'UNSUPPORTED_ATTACHMENTS'
  | 'NO_INVOICE_ATTACHMENT'
  /** Reading it failed MAX_READ_ATTEMPTS times (gmail.service.ts); the error is on the event. */
  | 'READ_FAILED'
  /** Its sender was approved, but it arrived before GMAIL_POLL_AFTER: entered by hand, if at all. */
  | 'BEFORE_CUTOFF';

/**
 * Skips that may be an invoice or a ticket nobody has: a file the reader does
 * not take, one that is not what it says, an iPhone photo, a list of loads
 * with no invoice. A logo, an icon, a statement or a repeat is left out on
 * purpose and needs nobody.
 */
const NEEDS_A_PERSON = new Set<string>([
  ATTACHMENT_REASONS.unsupported,
  ATTACHMENT_REASONS.mismatch,
  ATTACHMENT_REASONS.heic,
  ATTACHMENT_REASONS.sheetOfLoads,
]);

function needsPerson(record: AttachmentRecord): boolean {
  return record.action === 'review' || (record.reason !== null && NEEDS_A_PERSON.has(record.reason));
}

/**
 * Whether an email from a known sender still needs a person, from what
 * happened to its attachments.
 *
 *   SPREADSHEET   a spreadsheet the app could not read (.xls, or a damaged
 *                 file), even beside a PDF that was read: it may be the
 *                 invoice and the PDF a cover page.
 *   CREDIT_MEMO   money the supplier owes CGC; the app holds invoices only,
 *                 so somebody enters it by hand.
 *   PARTLY_READ   one attachment was read, but another needs a person: a
 *                 second invoice sent as a photo the reader cannot take, a
 *                 Word file, a list of loads. Marking the email done would
 *                 hide that file on a log row nobody opens.
 *
 * Otherwise an email is done once one attachment was read (an invoice,
 * tickets or a supporting file), or when what it carried was a statement:
 * that is recorded on the event and is not a bill to pay.
 */
export function attachmentReviewReason(records: readonly AttachmentRecord[]): ReviewReason | null {
  if (records.some(r => r.kind === 'spreadsheet' && r.action === 'review')) return 'SPREADSHEET';
  if (records.some(r => r.pages?.some(p => p.kind === 'credit_memo'))) return 'CREDIT_MEMO';
  if (records.some(r => r.action === 'read')) return records.some(needsPerson) ? 'PARTLY_READ' : null;
  if (records.some(r => r.reason === ATTACHMENT_REASONS.unsupported || r.reason === ATTACHMENT_REASONS.mismatch || r.reason === ATTACHMENT_REASONS.heic)) {
    return 'UNSUPPORTED_ATTACHMENTS';
  }
  if (records.some(r => r.pages?.some(p => p.kind === 'statement')) && !records.some(needsPerson)) return null;
  return 'NO_INVOICE_ATTACHMENT';
}

/** The records for an email nobody reads yet: candidates held, skips kept. */
export function heldRecords(candidates: readonly AttachmentCandidate[], reason: string): AttachmentRecord[] {
  return candidates.map(({ record }) =>
    record.action === 'read' ? { ...record, action: 'held' as const, reason } : record
  );
}
