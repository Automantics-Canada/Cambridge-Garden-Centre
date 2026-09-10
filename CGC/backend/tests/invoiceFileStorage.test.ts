import './setupEnv.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import fs from 'node:fs/promises';

test('invoice storage preserves every PDF page and leaves image bytes unchanged', async (t) => {
  const requests: { url: string; contentType: string | null; bytes: Buffer }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).hostname, 'test-project.supabase.co');
    assert.equal(request.method, 'POST');
    requests.push({
      url: request.url,
      contentType: request.headers.get('content-type'),
      bytes: Buffer.from(await request.arrayBuffer()),
    });
    return new Response(JSON.stringify({ Key: 'test-bucket/synthetic', Id: 'synthetic' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  });
  const { saveInvoiceImage } = await import('../src/services/fileStorage.js');
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText('Synthetic invoice: first page');
  pdf.addPage().drawText('Synthetic invoice: second page, additional line');
  const bytes = Buffer.from(await pdf.save());
  const url = await saveInvoiceImage(bytes, 'two-page-invoice.PDF');
  assert.match(url, /\.pdf$/i);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.contentType, 'application/pdf');
  assert.deepEqual(requests[0]!.bytes, bytes);
  assert.equal((await PDFDocument.load(requests[0]!.bytes)).getPageCount(), 2);

  const image = await fs.readFile(new URL('./fixtures/synthetic-ticket.png', import.meta.url));
  await saveInvoiceImage(image, 'synthetic-invoice.png');
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.contentType, 'image/png');
  assert.deepEqual(requests[1]!.bytes, image);
});
