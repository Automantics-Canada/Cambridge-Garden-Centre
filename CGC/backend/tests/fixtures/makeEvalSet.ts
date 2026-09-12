import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * Builds a scored evaluation set for the extraction provider.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * Every document here is invented and every degradation is applied
 * programmatically. That makes it safe to regenerate anywhere and safe to
 * describe in a pull request, and it is the only kind of set that can live
 * alongside this code — real tickets carry customer names, addresses and
 * prices, and they must never enter this repository.
 *
 * It is a **proxy, not the real measurement.** A rendered ticket blurred by
 * code is not a photograph taken one-handed in a truck cab of a carbon copy
 * that has been folded in a pocket since Tuesday. Treat a good score here as
 * "no obvious weakness" and a bad score as a genuine problem. The number that
 * decides whether this model ships is still the one from 15–25 real documents
 * with hand-checked values, which a person has to assemble.
 *
 * WHAT IT COVERS
 *
 * The failures that actually happen on this paperwork:
 *   - gross / tare / net on one ticket, where only net was delivered
 *   - "Cambridge Garden Centre" printed as the Bill To on every document
 *   - a supplier whose wording differs from CGC's product name
 *   - tonnes against cubic yards
 *   - a delivery charge line with no quantity worth speaking of
 * crossed with the conditions a phone camera imposes: skew, motion blur, low
 * light, glare, a fold, and the washed-out grey of a third carbon copy.
 *
 * Run:  npx tsx tests/fixtures/makeEvalSet.ts
 * Then: EXTRACTION_EVAL_DIR=.extraction-eval npm run extraction:eval
 *
 * Output goes to `.extraction-eval/`, which is gitignored — the generator is
 * committed, the generated files are not, so the repository stays light and the
 * set is reproducible from source.
 */

const OUT = path.resolve(process.env.EXTRACTION_EVAL_DIR || '.extraction-eval');

interface TicketSpec {
  id: string;
  supplier: string;
  address: string;
  ticketNumber: string;
  date: string;
  po: string;
  material: string;
  gross: string;
  tare: string;
  net: number;
  unit: string;
}

/** Five suppliers with different layouts, wording and units. */
const TICKETS: TicketSpec[] = [
  {
    id: 'millbrook',
    supplier: 'MILLBROOK AGGREGATES LTD.',
    address: '4120 County Road 12, Millbrook ON',
    ticketNumber: 'T-88213',
    date: '2026-08-13',
    po: '482913',
    material: 'A Gravel 19mm',
    gross: '41.20',
    tare: '16.60',
    net: 24.6,
    unit: 'tonnes',
  },
  {
    id: 'huntsridge',
    supplier: 'HUNTSRIDGE QUARRY',
    address: '88 Quarry Line, Puslinch ON',
    ticketNumber: 'HQ-40122',
    date: '2026-08-14',
    po: '517204',
    material: 'Screened Sand',
    gross: '38.05',
    tare: '15.45',
    net: 22.6,
    unit: 'tonnes',
  },
  {
    id: 'oakbend',
    supplier: 'OAKBEND SOIL & MULCH',
    address: '12 Sideroad 7, Ayr ON',
    ticketNumber: '2026-5591',
    date: '2026-08-17',
    po: 'equals 600418',
    material: 'Triple Mix Topsoil',
    gross: '—',
    tare: '—',
    // Sold by volume, so this one is never comparable with a tonnage order.
    net: 18,
    unit: 'cubic yards',
  },
  {
    id: 'rowanstone',
    supplier: 'ROWANSTONE MATERIALS INC.',
    address: 'RR 3, Drumbo ON',
    ticketNumber: 'RS 771904',
    date: '2026-08-19',
    po: 'equals 604412',
    // Supplier's own wording, not CGC's. Needs an alias to resolve.
    material: '3/4 CLEAR STONE',
    gross: '44.90',
    tare: '17.30',
    net: 27.6,
    unit: 'tonnes',
  },
  {
    id: 'fernhill',
    supplier: 'FERNHILL SAND & GRAVEL',
    address: '901 Concession 4, Brant ON',
    ticketNumber: 'F-10233',
    date: '2026-08-21',
    po: '612077',
    material: 'Limestone Screenings',
    gross: '36.40',
    tare: '14.90',
    net: 21.5,
    unit: 'tonnes',
  },
];

/** SVG is XML: an unescaped "&" in a supplier name kills the whole render. */
function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function ticketSvg(spec: TicketSpec): string {
  const weights =
    spec.gross === '—'
      ? `<text x="60" y="512" font-family="Helvetica" font-size="20">VOLUME LOAD — no scale weights</text>`
      : `<text x="60"  y="512" font-family="Helvetica" font-size="20">GROSS</text>
         <text x="300" y="512" font-family="Helvetica" font-size="20">${spec.gross}  ${xml(spec.unit)}</text>
         <text x="60"  y="552" font-family="Helvetica" font-size="20">TARE</text>
         <text x="300" y="552" font-family="Helvetica" font-size="20">${spec.tare}  ${xml(spec.unit)}</text>
         <line x1="60" y1="572" x2="520" y2="572" stroke="#333" stroke-width="1.5"/>`;

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1150">
  <rect width="900" height="1150" fill="#f7f5ef"/>
  <text x="60" y="80"  font-family="Helvetica" font-size="32" font-weight="bold">${xml(spec.supplier)}</text>
  <text x="60" y="112" font-family="Helvetica" font-size="18">${xml(spec.address)}</text>
  <text x="60" y="138" font-family="Helvetica" font-size="18">Weigh Scale Ticket</text>
  <line x1="60" y1="160" x2="840" y2="160" stroke="#333" stroke-width="2"/>

  <text x="60"  y="205" font-family="Helvetica" font-size="21" font-weight="bold">TICKET No.</text>
  <text x="280" y="205" font-family="Helvetica" font-size="21">${xml(spec.ticketNumber)}</text>
  <text x="540" y="205" font-family="Helvetica" font-size="21" font-weight="bold">DATE</text>
  <text x="680" y="205" font-family="Helvetica" font-size="21">${xml(spec.date)}</text>

  <text x="60"  y="248" font-family="Helvetica" font-size="21" font-weight="bold">P.O. NUMBER</text>
  <text x="280" y="248" font-family="Helvetica" font-size="21">${xml(spec.po.replace('equals ', ''))}</text>

  <rect x="60" y="285" width="780" height="92" fill="none" stroke="#666" stroke-width="1.5"/>
  <text x="78" y="315" font-family="Helvetica" font-size="17" font-weight="bold">BILL TO</text>
  <text x="78" y="345" font-family="Helvetica" font-size="19">Cambridge Garden Centre</text>
  <text x="78" y="368" font-family="Helvetica" font-size="16">1825 Franklin Blvd, Cambridge ON</text>

  <line x1="60" y1="410" x2="840" y2="410" stroke="#333" stroke-width="2"/>
  <text x="60"  y="452" font-family="Helvetica" font-size="21" font-weight="bold">MATERIAL</text>
  <text x="300" y="452" font-family="Helvetica" font-size="21">${xml(spec.material)}</text>

  ${weights}

  <text x="60"  y="608" font-family="Helvetica" font-size="24" font-weight="bold">NET</text>
  <text x="300" y="608" font-family="Helvetica" font-size="24" font-weight="bold">${spec.net.toFixed(2)}  ${xml(spec.unit)}</text>

  <line x1="60" y1="660" x2="840" y2="660" stroke="#333" stroke-width="2"/>
  <text x="60" y="700" font-family="Helvetica" font-size="16">Scale operator: R. Whyte</text>
  <text x="60" y="800" font-family="Helvetica" font-size="16">Driver signature: ______________________</text>
</svg>`;
}

type Condition =
  | 'clean'
  | 'skewed'
  | 'motion_blur'
  | 'low_light'
  | 'glare'
  | 'creased'
  | 'carbon_copy';

/** The conditions a phone camera in a truck cab actually imposes. */
async function degrade(svg: string, condition: Condition): Promise<Buffer> {
  const base = sharp(Buffer.from(svg));

  switch (condition) {
    case 'clean':
      return base.png().toBuffer();

    case 'skewed':
      // Held at an angle, as every one-handed photograph is.
      return base.rotate(6, { background: '#cfcabc' }).png().toBuffer();

    case 'motion_blur':
      return base.blur(3.2).png().toBuffer();

    case 'low_light':
      // Cab interior, late afternoon.
      return base.modulate({ brightness: 0.52 }).linear(0.9, -8).png().toBuffer();

    case 'glare': {
      // Sun across the upper third, washing out the header and the PO line.
      const { width = 900, height = 1150 } = await base.metadata();
      const glareSvg = `
        <svg width="${width}" height="${height}">
          <defs>
            <linearGradient id="g" x1="0" y1="0" x2="0.4" y2="1">
              <stop offset="0%" stop-color="#ffffff" stop-opacity="0.92"/>
              <stop offset="35%" stop-color="#ffffff" stop-opacity="0.35"/>
              <stop offset="60%" stop-color="#ffffff" stop-opacity="0"/>
            </linearGradient>
          </defs>
          <rect width="${width}" height="${height}" fill="url(#g)"/>
        </svg>`;
      return base
        .composite([{ input: Buffer.from(glareSvg), blend: 'over' }])
        .png()
        .toBuffer();
    }

    case 'creased': {
      // Folded in a pocket: two shadow lines and a slight blur along them.
      const { width = 900, height = 1150 } = await base.metadata();
      const foldSvg = `
        <svg width="${width}" height="${height}">
          <rect x="0" y="${Math.round(height * 0.33)}" width="${width}" height="3" fill="#000" opacity="0.28"/>
          <rect x="0" y="${Math.round(height * 0.66)}" width="${width}" height="3" fill="#000" opacity="0.22"/>
          <rect x="${Math.round(width * 0.5)}" y="0" width="2" height="${height}" fill="#000" opacity="0.16"/>
        </svg>`;
      return base
        .composite([{ input: Buffer.from(foldSvg), blend: 'over' }])
        .blur(1.1)
        .png()
        .toBuffer();
    }

    case 'carbon_copy': {
      // The third copy in the book: barely any contrast left, blue-grey, soft,
      // and speckled. This one is meant to be near the edge of legible — a
      // model that answers it confidently and wrongly is worse than one that
      // says it could not read it.
      const { width = 900, height = 1150 } = await base.metadata();
      const speckle = `
        <svg width="${width}" height="${height}">
          ${Array.from({ length: 900 }, () => {
            const x = Math.round(Math.random() * width);
            const y = Math.round(Math.random() * height);
            const r = (Math.random() * 1.6 + 0.4).toFixed(1);
            return `<circle cx="${x}" cy="${y}" r="${r}" fill="#7d8596" opacity="0.28"/>`;
          }).join('')}
        </svg>`;
      return base
        .linear(0.3, 150)
        .tint({ r: 214, g: 219, b: 232 })
        .composite([{ input: Buffer.from(speckle), blend: 'over' }])
        .blur(2.1)
        .png()
        .toBuffer();
    }
  }
}

/** A supplier invoice, optionally spilling onto a second page. */
async function invoicePdf(options: {
  supplier: string;
  invoiceNumber: string;
  date: string;
  po: string;
  lines: Array<[string, string, string, string, string, string]>;
  total: string;
  twoPages: boolean;
}): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const newPage = () => pdf.addPage([612, 792]);
  let page = newPage();

  const draw = (text: string, x: number, y: number, o: { size?: number; bold?: boolean } = {}) =>
    page.drawText(text, {
      x,
      y,
      size: o.size ?? 10,
      font: o.bold ? bold : font,
      color: rgb(0.1, 0.1, 0.1),
    });

  draw(options.supplier, 50, 740, { size: 17, bold: true });
  draw('INVOICE', 470, 740, { size: 17, bold: true });
  draw('Invoice No.', 470, 706, { bold: true });
  draw(options.invoiceNumber, 470, 692);
  draw('Date', 470, 672, { bold: true });
  draw(options.date, 470, 658);
  draw('BILL TO', 50, 690, { bold: true });
  draw('Cambridge Garden Centre', 50, 675);
  draw('1825 Franklin Blvd, Cambridge ON', 50, 661);
  draw('P.O. Number', 50, 630, { bold: true });
  draw(options.po, 130, 630);

  let y = 590;
  const header = () => {
    draw('LINE', 50, y, { bold: true });
    draw('DESCRIPTION', 90, y, { bold: true });
    draw('P.O.', 285, y, { bold: true });
    draw('QTY', 340, y, { bold: true });
    draw('UNIT', 390, y, { bold: true });
    draw('RATE', 450, y, { bold: true });
    draw('AMOUNT', 520, y, { bold: true });
    page.drawLine({ start: { x: 50, y: y - 6 }, end: { x: 562, y: y - 6 }, thickness: 1 });
    y -= 26;
  };
  header();

  options.lines.forEach((line, index) => {
    // Page break partway through, so a reader that only sees page one is short.
    if (options.twoPages && index === Math.ceil(options.lines.length / 2)) {
      draw('continued overleaf', 50, y - 10, { size: 8 });
      page = newPage();
      y = 700;
      header();
    }
    const [no, desc, po, qty, unit, amount] = line;
    draw(no, 50, y);
    draw(desc, 90, y);
    draw(po, 285, y);
    draw(qty, 340, y);
    draw(unit, 390, y);
    draw(amount, 520, y);
    y -= 22;
  });

  draw('TOTAL', 450, y - 30, { bold: true, size: 12 });
  draw(options.total, 520, y - 30, { bold: true, size: 12 });

  return Buffer.from(await pdf.save());
}

interface Case {
  file: string;
  kind: 'ticket' | 'invoice';
  unreadable?: boolean;
  condition: string;
  expected: Record<string, unknown>;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const cases: Case[] = [];

  // Each supplier under a different condition, so no single layout carries the
  // whole verdict for a given kind of damage.
  const pairings: Array<[TicketSpec, Condition]> = [
    [TICKETS[0]!, 'clean'],
    [TICKETS[0]!, 'creased'],
    [TICKETS[1]!, 'skewed'],
    [TICKETS[1]!, 'low_light'],
    [TICKETS[2]!, 'clean'],
    [TICKETS[2]!, 'glare'],
    [TICKETS[3]!, 'clean'],
    [TICKETS[3]!, 'motion_blur'],
    [TICKETS[4]!, 'carbon_copy'],
    [TICKETS[4]!, 'skewed'],
  ];

  for (const [spec, condition] of pairings) {
    const file = `ticket-${spec.id}-${condition}.png`;
    fs.writeFileSync(path.join(OUT, file), await degrade(ticketSvg(spec), condition));
    cases.push({
      file,
      kind: 'ticket',
      condition,
      // The heavily degraded ones are where a confident wrong answer is worst.
      unreadable: condition === 'carbon_copy' || condition === 'motion_blur',
      expected: {
        supplierName: spec.supplier
          .replace(/\b(LTD\.|INC\.)/g, '')
          .replace(/\s+/g, ' ')
          .trim(),
        ticketNumber: spec.ticketNumber,
        ticketDate: spec.date,
        poNumber: spec.po.replace('equals ', ''),
        quantity: spec.net,
        unit: spec.unit,
      },
    });
  }

  const invoices = [
    {
      name: 'invoice-millbrook-single.pdf',
      twoPages: false,
      supplier: 'MILLBROOK AGGREGATES LTD.',
      invoiceNumber: 'INV-5512',
      date: '2026-08-31',
      po: '482913',
      total: '1120.34',
      lines: [
        ['1', 'A Gravel 19mm', '482913', '24.60', 'tonnes', '461.25'],
        ['2', 'Screened Sand', '482913', '18.00', 'tonnes', '385.20'],
        ['3', 'Delivery charge - Cambridge', '482913', '1.00', 'each', '145.00'],
      ] as Array<[string, string, string, string, string, string]>,
    },
    {
      name: 'invoice-rowanstone-twopage.pdf',
      twoPages: true,
      supplier: 'ROWANSTONE MATERIALS INC.',
      invoiceNumber: 'RS-2026-0844',
      date: '2026-08-28',
      po: '604412',
      total: '2914.80',
      lines: [
        ['1', '3/4 Clear Stone', '604412', '27.60', 'tonnes', '772.80'],
        ['2', '3/4 Clear Stone', '604412', '27.60', 'tonnes', '772.80'],
        ['3', 'Limestone Screenings', '604412', '21.50', 'tonnes', '602.00'],
        ['4', 'Triple Mix Topsoil', '604412', '18.00', 'cubic yards', '648.00'],
        ['5', 'Fuel surcharge', '604412', '1.00', 'each', '119.20'],
      ] as Array<[string, string, string, string, string, string]>,
    },
  ];

  for (const invoice of invoices) {
    fs.writeFileSync(path.join(OUT, invoice.name), await invoicePdf(invoice));
    cases.push({
      file: invoice.name,
      kind: 'invoice',
      condition: invoice.twoPages ? 'two_pages' : 'clean',
      expected: {
        supplierName: invoice.supplier.replace(/\b(LTD\.|INC\.)/g, '').replace(/\s+/g, ' ').trim(),
        invoiceNumber: invoice.invoiceNumber,
        invoiceDate: invoice.date,
        poNumber: invoice.po,
        totalAmount: Number(invoice.total),
      },
    });
  }

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(cases, null, 2));

  console.log(`Wrote ${cases.length} documents and a manifest to ${OUT}`);
  console.log('Conditions:', [...new Set(cases.map((c) => c.condition))].join(', '));
  console.log('\nNext:  EXTRACTION_EVAL_DIR=' + OUT + ' npm run extraction:eval');
}

main().catch((error) => {
  console.error('[makeEvalSet]', error);
  process.exit(1);
});
