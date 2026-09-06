import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * Generates the synthetic documents the extraction tests use.
 *
 * Every company, PO number and price here is invented. No client paperwork is
 * committed to this repository, and none should be: the real documents carry
 * customer names, addresses and prices, and they are already the subject of one
 * unresolved question about what sits in this repo's history.
 *
 * They deliberately reproduce the two things about CGC's paperwork that have
 * actually caused misreadings:
 *   - "Cambridge Garden Centre" is printed on every document as the BILL TO,
 *     and was repeatedly extracted as the supplier.
 *   - Scale tickets print gross, tare and net weights together, and only the
 *     net is what was delivered.
 *
 * Run with:  npx tsx tests/fixtures/makeFixtures.ts
 */

const outputDir = path.dirname(fileURLToPath(import.meta.url));

const TICKET_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1150">
  <rect width="900" height="1150" fill="#f7f5ef"/>
  <text x="60" y="80"  font-family="Helvetica" font-size="34" font-weight="bold">MILLBROOK AGGREGATES LTD.</text>
  <text x="60" y="112" font-family="Helvetica" font-size="19">4120 County Road 12, Millbrook ON</text>
  <text x="60" y="138" font-family="Helvetica" font-size="19">Pit 44 — Weigh Scale Ticket</text>
  <line x1="60" y1="160" x2="840" y2="160" stroke="#333" stroke-width="2"/>

  <text x="60"  y="205" font-family="Helvetica" font-size="21" font-weight="bold">TICKET No.</text>
  <text x="260" y="205" font-family="Helvetica" font-size="21">T-88213</text>
  <text x="520" y="205" font-family="Helvetica" font-size="21" font-weight="bold">DATE</text>
  <text x="660" y="205" font-family="Helvetica" font-size="21">2026-08-13</text>

  <text x="60"  y="248" font-family="Helvetica" font-size="21" font-weight="bold">P.O. NUMBER</text>
  <text x="260" y="248" font-family="Helvetica" font-size="21">482913</text>
  <text x="520" y="248" font-family="Helvetica" font-size="21" font-weight="bold">TRUCK</text>
  <text x="660" y="248" font-family="Helvetica" font-size="21">44-B</text>

  <rect x="60" y="285" width="780" height="92" fill="none" stroke="#666" stroke-width="1.5"/>
  <text x="78" y="315" font-family="Helvetica" font-size="18" font-weight="bold">BILL TO</text>
  <text x="78" y="345" font-family="Helvetica" font-size="20">Cambridge Garden Centre</text>
  <text x="78" y="368" font-family="Helvetica" font-size="17">1825 Franklin Blvd, Cambridge ON</text>

  <line x1="60" y1="410" x2="840" y2="410" stroke="#333" stroke-width="2"/>
  <text x="60"  y="452" font-family="Helvetica" font-size="21" font-weight="bold">MATERIAL</text>
  <text x="300" y="452" font-family="Helvetica" font-size="21">A Gravel 19mm</text>

  <text x="60"  y="512" font-family="Helvetica" font-size="20">GROSS</text>
  <text x="300" y="512" font-family="Helvetica" font-size="20">41.20  tonnes</text>
  <text x="60"  y="552" font-family="Helvetica" font-size="20">TARE</text>
  <text x="300" y="552" font-family="Helvetica" font-size="20">16.60  tonnes</text>
  <line x1="60" y1="572" x2="520" y2="572" stroke="#333" stroke-width="1.5"/>
  <text x="60"  y="608" font-family="Helvetica" font-size="24" font-weight="bold">NET</text>
  <text x="300" y="608" font-family="Helvetica" font-size="24" font-weight="bold">24.60  tonnes</text>

  <line x1="60" y1="660" x2="840" y2="660" stroke="#333" stroke-width="2"/>
  <text x="60" y="700" font-family="Helvetica" font-size="17">Scale operator: R. Whyte</text>
  <text x="60" y="726" font-family="Helvetica" font-size="17">Time out: 09:42</text>
  <text x="60" y="800" font-family="Helvetica" font-size="17">Driver signature: ______________________</text>
  <text x="60" y="860" font-family="Helvetica" font-size="15" fill="#555">Material leaves the pit at the purchaser's risk.</text>
</svg>`;

async function writeTicket(): Promise<void> {
  const target = path.join(outputDir, 'synthetic-ticket.png');
  await sharp(Buffer.from(TICKET_SVG)).png().toFile(target);
  console.log(`wrote ${path.basename(target)}`);
}

/**
 * The same ticket as a phone photo taken badly: softened, darkened and slightly
 * rotated. Extraction should still read it, or say honestly that it could not.
 */
async function writePoorTicket(): Promise<void> {
  const target = path.join(outputDir, 'synthetic-ticket-poor.png');
  await sharp(Buffer.from(TICKET_SVG))
    .rotate(3, { background: '#d9d4c8' })
    .blur(2.2)
    .modulate({ brightness: 0.78 })
    .png()
    .toFile(target);
  console.log(`wrote ${path.basename(target)}`);
}

async function writeInvoice(): Promise<void> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const draw = (
    text: string,
    x: number,
    y: number,
    options: { size?: number; bold?: boolean } = {}
  ) => {
    page.drawText(text, {
      x,
      y,
      size: options.size ?? 10,
      font: options.bold ? bold : font,
      color: rgb(0.1, 0.1, 0.1),
    });
  };

  draw('MILLBROOK AGGREGATES LTD.', 50, 740, { size: 18, bold: true });
  draw('4120 County Road 12, Millbrook ON  |  HST 81234 5678 RT0001', 50, 722, { size: 9 });
  draw('INVOICE', 460, 740, { size: 18, bold: true });

  draw('Invoice No.', 460, 706, { bold: true });
  draw('INV-5512', 460, 692);
  draw('Date', 460, 672, { bold: true });
  draw('2026-08-31', 460, 658);

  draw('BILL TO', 50, 690, { bold: true });
  draw('Cambridge Garden Centre', 50, 675);
  draw('1825 Franklin Blvd, Cambridge ON', 50, 661);

  draw('P.O. Number', 50, 630, { bold: true });
  draw('482913', 130, 630);

  // Header row. The unit sits in its own column, which is where it usually is
  // on a real invoice and where a line-by-line reader tends to miss it.
  let y = 590;
  draw('LINE', 50, y, { bold: true });
  draw('DESCRIPTION', 90, y, { bold: true });
  draw('P.O.', 285, y, { bold: true });
  draw('QTY', 340, y, { bold: true });
  draw('UNIT', 390, y, { bold: true });
  draw('RATE', 450, y, { bold: true });
  draw('AMOUNT', 520, y, { bold: true });
  page.drawLine({ start: { x: 50, y: y - 6 }, end: { x: 562, y: y - 6 }, thickness: 1 });

  const lines = [
    ['1', 'A Gravel 19mm', '482913', '24.60', 'tonnes', '18.75', '461.25'],
    ['2', 'Screened Sand', '482913', '18.00', 'tonnes', '21.40', '385.20'],
    ['3', 'Delivery charge - Cambridge', '482913', '1.00', 'each', '145.00', '145.00'],
  ];

  y -= 26;
  for (const [line, description, po, qty, unit, rate, amount] of lines) {
    draw(line!, 50, y);
    draw(description!, 90, y);
    draw(po!, 285, y);
    draw(qty!, 340, y);
    draw(unit!, 390, y);
    draw(rate!, 450, y);
    draw(amount!, 520, y);
    y -= 22;
  }

  page.drawLine({ start: { x: 340, y: y - 2 }, end: { x: 562, y: y - 2 }, thickness: 1 });
  draw('Subtotal', 450, y - 22);
  draw('991.45', 520, y - 22);
  draw('HST 13%', 450, y - 40);
  draw('128.89', 520, y - 40);
  draw('TOTAL', 450, y - 62, { bold: true, size: 12 });
  draw('1120.34', 520, y - 62, { bold: true, size: 12 });

  draw('Terms: net 30. Interest at 2% per month on overdue accounts.', 50, 90, { size: 8 });

  const target = path.join(outputDir, 'synthetic-invoice.pdf');
  fs.writeFileSync(target, await pdf.save());
  console.log(`wrote ${path.basename(target)}`);
}

async function main(): Promise<void> {
  await writeTicket();
  await writePoorTicket();
  await writeInvoice();
}

main().catch((error) => {
  console.error('[makeFixtures]', error);
  process.exit(1);
});
