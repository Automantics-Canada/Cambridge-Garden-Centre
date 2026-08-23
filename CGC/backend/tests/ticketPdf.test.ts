import './setupEnv.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { renderTicketPdfPages } from '../src/modules/tickets/ticket.controller.js';

describe('multi-page ticket PDF rendering', () => {
  it('renders every source page instead of silently retaining only page one', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (const label of ['SANITIZED TICKET ONE', 'SANITIZED TICKET TWO']) {
      const page = pdf.addPage([320, 180]);
      page.drawText(label, { x: 24, y: 90, size: 18, font });
    }

    const pages = await renderTicketPdfPages(Buffer.from(await pdf.save()));
    assert.equal(pages.length, 2);
    for (const image of pages) {
      assert.ok(image.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      ));
    }
  });
});
