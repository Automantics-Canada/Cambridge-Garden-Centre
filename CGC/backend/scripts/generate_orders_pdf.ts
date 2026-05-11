import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fs from 'fs';
import path from 'path';

async function generatePdf() {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([842, 595]); // Landscape A4
  const { width, height } = page.getSize();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const fontSize = 10;
  const margin = 50;
  let y = height - margin;

  // Title
  page.drawText('Spruce Order Export', { x: margin, y, size: 16, font: boldFont });
  y -= 30;

  // Table Headers
  const headers = [
    'Document',
    'Order Date',
    'Required Date',
    'Customer Name',
    'Description',
    'Qty',
    'Order Notes'
  ];

  const colWidths = [70, 70, 70, 150, 200, 50, 150];
  let x = margin;

  // Draw Header Background
  page.drawRectangle({
    x: margin,
    y: y - 5,
    width: width - 2 * margin,
    height: 20,
    color: rgb(0.9, 0.9, 0.9),
  });

  headers.forEach((header, i) => {
    page.drawText(header, { x: x + 5, y, size: fontSize, font: boldFont });
    x += colWidths[i];
  });

  y -= 20;

  // Data Row
  const rowData = [
    '351303',
    '03/30/2026',
    '03/30/2026',
    'Cambridge Garden Ctr',
    'Pallet Return - Repairable (99050140)',
    '99',
    'PO: R-1056773'
  ];

  x = margin;
  rowData.forEach((text, i) => {
    page.drawText(text, { x: x + 5, y, size: fontSize, font });
    x += colWidths[i];
  });

  // Draw Table Lines
  const tableBottom = y - 10;
  const tableTop = height - margin - 30;
  
  // Horizontal lines
  page.drawLine({ start: { x: margin, y: tableTop + 15 }, end: { x: width - margin, y: tableTop + 15 }, thickness: 1 });
  page.drawLine({ start: { x: margin, y: tableTop - 5 }, end: { x: width - margin, y: tableTop - 5 }, thickness: 1 });
  page.drawLine({ start: { x: margin, y: tableBottom }, end: { x: width - margin, y: tableBottom }, thickness: 1 });

  // Vertical lines
  x = margin;
  page.drawLine({ start: { x, y: tableTop + 15 }, end: { x, y: tableBottom }, thickness: 1 });
  colWidths.forEach((w) => {
    x += w;
    page.drawLine({ start: { x, y: tableTop + 15 }, end: { x, y: tableBottom }, thickness: 1 });
  });

  const pdfBytes = await pdfDoc.save();
  const outputPath = path.join(process.cwd(), 'orders_export.pdf');
  fs.writeFileSync(outputPath, pdfBytes);
  console.log(`PDF generated at ${outputPath}`);
}

generatePdf().catch(console.error);
