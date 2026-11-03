import './setupEnv.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ATTACHMENT_REASONS,
  attachmentReviewReason,
  classifyDownloaded,
  storedFileName,
  triageAttachments,
  type AttachmentRecord,
} from '../src/services/emailAttachments.js';

/** Attachment selection on Gmail part shapes, with no Gmail. Names are invented. */

const part = (over: Record<string, unknown>) => ({ partId: '1', body: { attachmentId: 'ATT-1', size: 50_000 }, ...over });
const one = (over: Record<string, unknown>) => triageAttachments({ parts: [part(over)] } as never)[0]!;
const PDF = Buffer.from('%PDF-1.7 synthetic');
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20_000)]);
const OLE = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);

describe('triageAttachments', () => {
  it('ignores the message body parts, but keeps a file sent with no name', () => {
    const parts = triageAttachments({
      parts: [
        { partId: '0', mimeType: 'text/plain', body: { data: 'aGk' } },
        { partId: '1', mimeType: 'text/html', body: { attachmentId: 'big-html-body' } },
        { partId: '2', mimeType: 'application/pdf', filename: '', body: { attachmentId: 'ATT-2' } },
      ],
    } as never);
    assert.deepEqual(parts.map(c => c.record.partId), ['2']);
    assert.equal(parts[0]!.record.kind, 'pdf');
    assert.equal(parts[0]!.needsBytes, true);
  });

  it('an inline logo is skipped without a download; an attached one of the same size is too small anyway', () => {
    const inline = one({ filename: 'image001.png', mimeType: 'image/png', body: { attachmentId: 'a', size: 6_000 }, headers: [{ name: 'Content-ID', value: '<x>' }] });
    assert.equal(inline.record.reason, ATTACHMENT_REASONS.inline);
    assert.equal(inline.needsBytes, false);
    const attached = one({ filename: 'image001.png', mimeType: 'image/png', body: { attachmentId: 'a', size: 6_000 } });
    assert.equal(attached.record.reason, ATTACHMENT_REASONS.tinyImage);
  });

  it('an image with a Content-ID but sent as an attachment is read', () => {
    const c = one({
      filename: 'scan.jpg', mimeType: 'image/jpeg', body: { attachmentId: 'a', size: 30_000 },
      headers: [{ name: 'Content-ID', value: '<scan>' }, { name: 'Content-Disposition', value: 'attachment; filename="scan.jpg"' }],
    });
    assert.equal(c.record.action, 'read');
  });

  it('spreadsheets by type or name are downloaded to be read; other files are listed as unsupported', () => {
    const excel = one({ filename: 'Invoice', mimeType: 'application/vnd.ms-excel' });
    assert.equal(excel.record.kind, 'spreadsheet');
    assert.equal(excel.record.action, 'read');
    assert.equal(excel.needsBytes, true, 'the bytes tell .xlsx, CSV and the old .xls apart');
    assert.equal(one({ filename: 'loads.CSV', mimeType: 'application/octet-stream' }).record.kind, 'spreadsheet');
    const docx = one({ filename: 'letter.docx', mimeType: 'application/octet-stream' });
    assert.equal(docx.record.reason, ATTACHMENT_REASONS.unsupported);
    assert.equal(docx.needsBytes, false);
  });
});

describe('classifyDownloaded', () => {
  const vague: AttachmentRecord = { name: 'Invoice 1', mimeType: 'application/octet-stream', size: null, partId: '1', kind: 'other', action: 'read', reason: null };

  it('decides by the bytes', () => {
    assert.equal(classifyDownloaded(vague, PDF).kind, 'pdf');
    assert.equal(classifyDownloaded(vague, JPEG).kind, 'image');
    assert.equal(classifyDownloaded(vague, ZIP).kind, 'spreadsheet');
    assert.equal(classifyDownloaded(vague, Buffer.from('plain text, not a csv invoice')).reason, ATTACHMENT_REASONS.unsupported);
  });

  it('a spreadsheet is read when it is .xlsx or a CSV, and the old .xls waits for a person', () => {
    const sheet: AttachmentRecord = { ...vague, name: 'invoice.xlsx', kind: 'spreadsheet' };
    assert.deepEqual([classifyDownloaded(sheet, ZIP).action, classifyDownloaded(sheet, ZIP).reason], ['read', null]);
    const csv = { ...sheet, name: 'invoice.csv', mimeType: 'text/csv' };
    assert.equal(classifyDownloaded(csv, Buffer.from('a,b\n1,2\n')).action, 'read');
    const xls = classifyDownloaded({ ...sheet, name: 'invoice.xls' }, OLE);
    assert.deepEqual([xls.kind, xls.action, xls.reason], ['spreadsheet', 'review', ATTACHMENT_REASONS.legacyXls]);
    // Unnamed and untyped: a workbook container is still a spreadsheet.
    assert.equal(classifyDownloaded(vague, OLE).reason, ATTACHMENT_REASONS.legacyXls);
    // Named .xlsx but not a workbook.
    assert.equal(classifyDownloaded(sheet, Buffer.from('<html></html>')).reason, ATTACHMENT_REASONS.mismatch);
  });

  it('the reading-arrives-later reason is gone', () => {
    assert.ok(!Object.values(ATTACHMENT_REASONS).some(reason => /later update/.test(reason)));
  });

  it('a claimed PDF that is not one says so', () => {
    const claimed = { ...vague, name: 'invoice.pdf', kind: 'pdf' as const };
    assert.equal(classifyDownloaded(claimed, Buffer.from('<html></html>')).reason, ATTACHMENT_REASONS.mismatch);
    assert.equal(classifyDownloaded(claimed, ZIP).reason, ATTACHMENT_REASONS.mismatch, 'a workbook named .pdf is not read as one');
  });
});

describe('storedFileName', () => {
  it('gives the stored copy the extension of its real type', () => {
    assert.equal(storedFileName('Invoice 1', PDF), 'Invoice_1.pdf');
    assert.equal(storedFileName('scan.jpeg', JPEG), 'scan.jpeg');
    assert.equal(storedFileName('scan.png', JPEG), 'scan.png.jpg');
    assert.equal(storedFileName('', PDF), 'invoice.pdf');
  });

  it('keeps a spreadsheet a spreadsheet', () => {
    assert.equal(storedFileName('Invoice 2', ZIP, 'spreadsheet'), 'Invoice_2.xlsx');
    assert.equal(storedFileName('loads.csv', Buffer.from('a,b'), 'spreadsheet'), 'loads.csv');
    assert.equal(storedFileName('detail.xlsx', ZIP, 'spreadsheet'), 'detail.xlsx');
  });
});

describe('attachmentReviewReason', () => {
  const r = (over: Partial<AttachmentRecord>): AttachmentRecord => ({ name: 'x', mimeType: null, size: null, partId: '1', kind: 'pdf', action: 'read', reason: null, ...over });

  it('a read attachment finishes the email unless a spreadsheet came with it', () => {
    assert.equal(attachmentReviewReason([r({})]), null);
    assert.equal(attachmentReviewReason([r({}), r({ kind: 'other', action: 'skipped', reason: ATTACHMENT_REASONS.unsupported })]), null);
    assert.equal(attachmentReviewReason([r({}), r({ kind: 'spreadsheet', action: 'review' })]), 'SPREADSHEET');
  });

  it('a credit memo waits for a person; a statement alone is recorded and done', () => {
    assert.equal(attachmentReviewReason([r({ action: 'review', pages: [{ page: 1, kind: 'credit_memo' }] })]), 'CREDIT_MEMO');
    assert.equal(
      attachmentReviewReason([r({ pages: [{ page: 1, kind: 'invoice' }, { page: 2, kind: 'credit_memo' }] })]),
      'CREDIT_MEMO',
      'even beside an invoice that was read'
    );
    assert.equal(attachmentReviewReason([r({ action: 'skipped', pages: [{ page: 1, kind: 'statement' }] })]), null);
    assert.equal(attachmentReviewReason([r({ action: 'skipped', pages: [{ page: 1, kind: 'other' }] })]), 'NO_INVOICE_ATTACHMENT');
    assert.equal(attachmentReviewReason([r({ kind: 'spreadsheet', action: 'review', reason: ATTACHMENT_REASONS.legacyXls })]), 'SPREADSHEET');
  });

  it('nothing read: unsupported files, or nothing at all', () => {
    assert.equal(attachmentReviewReason([r({ kind: 'other', action: 'skipped', reason: ATTACHMENT_REASONS.unsupported })]), 'UNSUPPORTED_ATTACHMENTS');
    assert.equal(attachmentReviewReason([r({ kind: 'image', action: 'skipped', reason: ATTACHMENT_REASONS.inline })]), 'NO_INVOICE_ATTACHMENT');
    assert.equal(attachmentReviewReason([]), 'NO_INVOICE_ATTACHMENT');
  });
});
