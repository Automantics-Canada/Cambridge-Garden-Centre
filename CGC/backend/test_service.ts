import { OrderImportService } from './src/modules/orders/order.service.js';
import fs from 'fs';

async function testDirectService() {
  try {
    const buffer = fs.readFileSync('Gary - Custom Report April 2026-51-100.csv');
    const summary = await OrderImportService.importFromCsv(buffer, 'Gary - Custom Report April 2026-51-100.csv');
    console.log(JSON.stringify(summary, null, 2));
  } catch (err: any) {
    console.error(err);
  }
}

testDirectService();
