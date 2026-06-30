import { GmailService } from '../services/gmail.service.js';

async function run() {
  try {
    console.log('Sending test email...');
    await GmailService.sendEmail('test@example.com', 'Test Email', '<p>Test</p>');
    console.log('Success!');
  } catch (error) {
    console.error('Error in script:', error);
  }
}

run();
