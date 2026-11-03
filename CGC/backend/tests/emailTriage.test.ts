import './setupEnv.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { describePages, planPages, unsortedPlan } from '../src/services/emailTriage.js';
import { extractPdfPages, inspectPdf, pdfPageCount } from '../src/lib/pdfPages.js';

/** Deciding what an emailed attachment's pages become. Pure, plus pdf-lib. */

const answer = (...kinds: Array<'invoice' | 'delivery_ticket' | 'statement' | 'credit_memo' | 'other'>) => ({
  pages: kinds.map((kind, i) => ({ page: i + 1, kind })),
});

describe('planPages', () => {
  it('splits a PDF into its invoice pages, in order, and one ticket per ticket page', () => {
    const plan = planPages(answer('invoice', 'invoice', 'delivery_ticket', 'statement', 'delivery_ticket'), 5);
    assert.deepEqual(plan.invoicePages, [1, 2]);
    assert.deepEqual(plan.ticketPages, [3, 5]);
    assert.equal(plan.split, true);
    assert.deepEqual(plan.pages.map(p => p.kind), ['invoice', 'invoice', 'delivery_ticket', 'statement', 'delivery_ticket']);
  });

  it('a page the answer left out goes with the invoice, so no invoice line is lost', () => {
    const plan = planPages({ pages: [{ page: 1, kind: 'invoice' }, { page: 3, kind: 'delivery_ticket' }] }, 3);
    assert.deepEqual(plan.invoicePages, [1, 2]);
    const noInvoice = planPages({ pages: [{ page: 1, kind: 'statement' }] }, 2);
    assert.deepEqual(noInvoice.pages.map(p => p.kind), ['statement', 'other']);
  });

  it('ignores answers for pages the file does not have, and repeats', () => {
    const plan = planPages({ pages: [{ page: 1, kind: 'invoice' }, { page: 1, kind: 'statement' }, { page: 9, kind: 'delivery_ticket' }] }, 2);
    assert.deepEqual(plan.invoicePages, [1, 2]);
    assert.deepEqual(plan.ticketPages, []);
  });

  it('a file handled whole takes one kind: an invoice anywhere in it wins', () => {
    assert.deepEqual(planPages(answer('delivery_ticket', 'invoice'), null).invoicePages, [1]);
    assert.deepEqual(planPages(answer('delivery_ticket'), 1).ticketPages, [1]);
    assert.deepEqual(planPages(answer('statement', 'credit_memo'), null).pages, [{ page: 1, kind: 'credit_memo' }]);
    assert.deepEqual(planPages({ pages: [] }, null).pages, [{ page: 1, kind: 'other' }]);
    assert.equal(planPages(answer('invoice'), null).split, false);
  });

  it('when nothing could be sorted, the file is one invoice, as the inbox always did', () => {
    assert.deepEqual(unsortedPlan().invoicePages, [1]);
  });
});

describe('describePages', () => {
  it('says what each run of pages was', () => {
    assert.equal(
      describePages(planPages(answer('invoice', 'invoice', 'delivery_ticket', 'delivery_ticket', 'statement'), 5).pages),
      'pages 1-2 invoice; pages 3-4 delivery tickets; page 5 statement (not billed)'
    );
    assert.equal(describePages([{ page: 1, kind: 'credit_memo' }]), 'credit memo (enter by hand)');
  });
});

describe('cutting PDF pages', () => {
  async function pdfWith(count: number): Promise<Buffer> {
    const pdf = await PDFDocument.create();
    for (let i = 1; i <= count; i += 1) pdf.addPage([200 + i, 100]);
    return Buffer.from(await pdf.save());
  }

  it('keeps the pages asked for, in that order', async () => {
    const out = await PDFDocument.load(await extractPdfPages(await pdfWith(4), [3, 1]));
    assert.deepEqual(out.getPages().map(p => p.getWidth()), [203, 201]);
  });

  it('counts pages, and says null for a file it cannot open', async () => {
    assert.equal(await pdfPageCount(await pdfWith(3)), 3);
    assert.equal(await pdfPageCount(Buffer.from('%PDF-1.4 not really')), null);
  });

  // A billing system's owner-password PDF opens in any viewer but not for
  // pdf-lib's copying. Its pages can still be counted, so a file of several
  // tickets is known to be several, and is not split into garbled pages.
  it('counts an encrypted PDF without splitting it', async () => {
    const pdf = await PDFDocument.create();
    for (let i = 0; i < 3; i += 1) pdf.addPage([200, 200]);
    pdf.context.trailerInfo.Encrypt = pdf.context.register(pdf.context.obj({ Filter: 'Standard', V: 1, R: 2, P: -4 }));
    const encrypted = Buffer.from(await pdf.save({ useObjectStreams: false }));

    assert.deepEqual(await inspectPdf(encrypted), { pageCount: 3, encrypted: true });
    assert.deepEqual(await inspectPdf(await pdfWith(2)), { pageCount: 2, encrypted: false });
    assert.deepEqual(await inspectPdf(Buffer.from('%PDF-1.4 not really')), { pageCount: null, encrypted: false });
    await assert.rejects(() => extractPdfPages(encrypted, [1]), /could not be opened/);
  });

  it('refuses a page that is not there', async () => {
    const two = await pdfWith(2);
    await assert.rejects(() => extractPdfPages(two, [3]), /Page 3/);
  });
});
