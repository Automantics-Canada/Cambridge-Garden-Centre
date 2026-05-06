import dotenv from 'dotenv';
dotenv.config();
import { MailService } from '../src/services/mail.service.js';

async function main() {
  console.log('Using GMAIL_USER:', process.env.GMAIL_USER);
  console.log('Using GMAIL_PASS:', process.env.GMAIL_PASS ? 'SET (hidden)' : 'NOT SET');
  
  const to = 'sundaramlear@gmail.com';
  const subject = 'Final Verification Test';
  const text = 'This is a test email to verify current credentials.';
  
  const result = await MailService.sendEmail(to, subject, text);
  console.log('Result:', result);
}

main().catch(console.error);
