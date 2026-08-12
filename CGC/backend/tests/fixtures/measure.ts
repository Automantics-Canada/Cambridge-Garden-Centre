/**
 * Reports real input/output sizes for synthetic ticket-shaped fixtures.
 *
 * Not part of the test suite: it produces evidence for the PR rather than
 * asserting anything. Every fixture is generated here — no client image is
 * involved.
 *
 *   npx tsx tests/fixtures/measure.ts
 */
import sharp from 'sharp';
import { generateThumbnail } from '../../src/services/thumbnail.service.js';

interface Case {
  label: string;
  format: 'jpeg' | 'png' | 'webp';
  width: number;
  height: number;
}

const CASES: Case[] = [
  { label: 'phone photo, portrait (JPEG q90)', format: 'jpeg', width: 1800, height: 2391 },
  { label: 'phone photo, landscape (JPEG q90)', format: 'jpeg', width: 2391, height: 1800 },
  { label: 'flatbed scan (PNG)', format: 'png', width: 1010, height: 752 },
  { label: 'small photo (JPEG q90)', format: 'jpeg', width: 747, height: 827 },
  { label: 'already WebP', format: 'webp', width: 1800, height: 2391 },
];

/** Ticket-like content so the encoder sees realistic detail, not flat colour. */
async function makeFixture(c: Case): Promise<Buffer> {
  const overlay = Buffer.from(
    `<svg width="${c.width}" height="${c.height}">
       <rect width="${c.width}" height="${c.height}" fill="#f2f2f0"/>
       <rect x="0" y="0" width="${c.width}" height="${Math.round(c.height / 6)}" fill="#1b4332"/>
       <text x="40" y="${Math.round(c.height / 10)}" font-size="${Math.round(c.width / 18)}" fill="#ffffff">DELIVERY TICKET 4821</text>
       <text x="40" y="${Math.round(c.height / 3)}" font-size="${Math.round(c.width / 26)}" fill="#111111">MATERIAL: 3/4 CLEAR STONE</text>
       <text x="40" y="${Math.round(c.height / 2.4)}" font-size="${Math.round(c.width / 26)}" fill="#111111">QTY: 12.5 MT</text>
       ${Array.from({ length: 18 }, (_, i) =>
         `<line x1="40" y1="${Math.round(c.height / 2) + i * 24}" x2="${c.width - 40}" y2="${Math.round(c.height / 2) + i * 24}" stroke="#cccccc" stroke-width="2"/>`
       ).join('')}
     </svg>`
  );

  const pipeline = sharp({
    create: { width: c.width, height: c.height, channels: 3, background: { r: 245, g: 245, b: 242 } },
  }).composite([{ input: overlay, top: 0, left: 0 }]);

  if (c.format === 'jpeg') return pipeline.jpeg({ quality: 90 }).toBuffer();
  if (c.format === 'png') return pipeline.png().toBuffer();
  return pipeline.webp().toBuffer();
}

async function main() {
  const rows: string[] = [];
  rows.push('| fixture | source dims | source bytes | thumb bytes | thumb dims | reduction |');
  rows.push('|---|---|---:|---:|---|---:|');

  let totalIn = 0;
  let totalOut = 0;

  for (const c of CASES) {
    const source = await makeFixture(c);
    const result = await generateThumbnail(source);
    const meta = await sharp(result.buffer).metadata();

    totalIn += result.sourceBytes;
    totalOut += result.bytes;

    const reduction = (100 - (result.bytes / result.sourceBytes) * 100).toFixed(1);
    rows.push(
      `| ${c.label} | ${c.width}x${c.height} | ${result.sourceBytes.toLocaleString()} | ` +
      `${result.bytes.toLocaleString()} | ${meta.width}x${meta.height} | ${reduction}% |`
    );
  }

  const overall = (100 - (totalOut / totalIn) * 100).toFixed(1);
  rows.push(`| **all five** | | **${totalIn.toLocaleString()}** | **${totalOut.toLocaleString()}** | | **${overall}%** |`);

  console.log(rows.join('\n'));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
