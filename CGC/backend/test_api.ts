import fs from 'fs';
import FormData from 'form-data';
import axios from 'axios';

async function testUpload() {
  try {
    const form = new FormData();
    form.append('file', fs.createReadStream('test_import.csv'));

    // Try without auth first to see if it works, or maybe auth is required?
    // Wait, the API requires auth: router.use(authMiddleware);
    // Let's just bypass auth by testing the service directly!
  } catch (err: any) {
    console.error(err.response?.data || err.message);
  }
}
testUpload();
