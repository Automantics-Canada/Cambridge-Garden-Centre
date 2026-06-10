import { pdfToPng } from 'pdf-to-png-converter';
import fs from 'node:fs';

async function main() {
  const pdfPath = process.argv[2];
  const pageNumStr = process.argv[3];
  
  if (!pdfPath) {
    console.error('Usage: tsx pdfToPngWorker.ts <pdfPath> [pageNum]');
    process.exit(1);
  }

  const pageNum = pageNumStr ? parseInt(pageNumStr, 10) : 1;
  const buffer = fs.readFileSync(pdfPath);
  
  const pngPages = await pdfToPng(buffer, {
    viewportScale: 2.0,
    pagesToProcess: [pageNum],
    disableFontFace: false,
    useSystemFonts: true,
    enableXfa: true,
  });

  if (pngPages && pngPages.length > 0 && pngPages[0]?.content) {
    process.stdout.write(pngPages[0].content);
  } else {
    console.error('Error: No pages rendered');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Worker error:', err);
  process.exit(1);
});
