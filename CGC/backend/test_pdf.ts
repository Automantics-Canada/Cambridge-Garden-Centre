import fs from 'fs';
import { OrderPdfImportService } from './src/modules/orders/orderPdfImport.service.js';

async function run() {
  try {
    // We don't have the real PDF, so we'll just test if the module loads and can parse a dummy one
    // Actually, we can use the test_import.csv? No, it's a CSV.
    // Let's create a minimal valid PDF buffer
    const minimalPdf = Buffer.from(
      '%PDF-1.1\n%¥±ë\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\nxref\n0 4\n0000000000 65535 f \n0000000015 00000 n \n0000000064 00000 n \n0000000122 00000 n \ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n212\n%%EOF',
      'ascii'
    );
    console.log('Testing import...');
    const result = await OrderPdfImportService.importFromPdf(minimalPdf, 'test-job');
    console.log('Result:', result);
  } catch (err) {
    console.error('Script error:', err);
  }
}

run();
