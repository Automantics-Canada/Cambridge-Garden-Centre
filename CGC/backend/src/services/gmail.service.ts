import { google } from 'googleapis';
import { env } from '../config/env.js';
import { InvoiceService } from '../modules/invoices/invoice.service.js';
import { prisma } from '../db/prisma.js';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.modify'];

export class GmailService {
  private static auth = new google.auth.OAuth2(
    env.gmailClientId,
    env.gmailClientSecret,
    'https://developers.google.com/oauthplayground'
  );

  static {
    if (env.gmailRefreshToken) {
      this.auth.setCredentials({ refresh_token: env.gmailRefreshToken });
    }
  }

  private static gmail = google.gmail({ version: 'v1', auth: this.auth });

  /**
   * Polls Gmail for new unread messages in ap@cambridgegardencentre.ca
   */
  static async pollInvoices() {
    if (!env.gmailClientId || !env.gmailRefreshToken) {
      console.warn('⚠️ Gmail API credentials not fully configured. Skipping polling.', {
        hasClientId: !!env.gmailClientId,
        hasRefreshToken: !!env.gmailRefreshToken
      });
      return;
    }

    try {
      console.log('📬 Checking Gmail for new invoices...');
      
      // Look for recent messages with attachments (ignoring unread status for better reliability)
      const res = await this.gmail.users.messages.list({
        userId: 'me',
        q: 'has:attachment',
        maxResults: 10
      });

      const messages = res.data.messages || [];
      console.log(`Found ${messages.length} potential email(s) with attachments to check.`);

      for (const msg of messages) {
        await this.processMessage(msg.id!);
      }
    } catch (error) {
      console.error('❌ Error polling Gmail:', error);
    }
  }

  private static async processMessage(messageId: string) {
    try {
      const res = await this.gmail.users.messages.get({
        userId: 'me',
        id: messageId,
      });

      const message = res.data;
      const headers = message.payload?.headers || [];
      const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
      const subject = headers.find(h => h.name === 'Subject')?.value || 'No Subject';

      console.log(`Processing email from ${from}: "${subject}"`);

      const attachments = this.getAttachments(message.payload!);
      
      if (attachments.length === 0) {
        console.log('No valid attachments found in this email.');
        await this.markAsRead(messageId);
        return;
      }

      for (const attachment of attachments) {
        const attachmentId = attachment.body.attachmentId!;
        const compositeId = `${messageId}:${attachmentId}`;

        // Check if we've already processed this specific attachment
        const existing = await prisma.invoice.findUnique({
          where: { gmailMessageId: compositeId }
        });

        if (existing) {
          console.log(`Attachment ${attachment.filename} from ${messageId} already processed. Skipping.`);
          continue;
        }

        const attachRes = await this.gmail.users.messages.attachments.get({
          userId: 'me',
          messageId: messageId,
          id: attachmentId,
        });

        const buffer = Buffer.from(attachRes.data.data!, 'base64');
        
        // Trigger Ingestion Pipeline
        console.log(`Ingesting attachment: ${attachment.filename}`);
        const result = await InvoiceService.ingestEmailInvoice({
          buffer,
          originalName: attachment.filename || 'invoice.pdf',
          fromEmail: from,
          subject: subject,
          gmailMessageId: compositeId
        });

        // Trigger OCR process automatically
        if (result.invoice.id) {
           InvoiceService.processInvoiceOcr(result.invoice.id).catch(err => {
             console.error(`OCR failed for invoice ${result.invoice.id}:`, err);
           });
        }
      }

      await this.markAsRead(messageId);
      console.log(`Successfully processed email ${messageId}`);
    } catch (error) {
      console.error(`Error processing message ${messageId}:`, error);
    }
  }

  private static getAttachments(payload: any): any[] {
    const attachments: any[] = [];
    
    const findAttachments = (part: any) => {
      if (part.filename && part.body?.attachmentId) {
        // Only allow PDF and Images
        const ext = part.filename.split('.').pop()?.toLowerCase();
        if (['pdf', 'jpg', 'jpeg', 'png'].includes(ext)) {
          attachments.push(part);
        }
      }
      if (part.parts) {
        part.parts.forEach(findAttachments);
      }
    };

    findAttachments(payload);
    return attachments;
  }

  private static async markAsRead(messageId: string) {
    try {
      await this.gmail.users.messages.batchModify({
        userId: 'me',
        ids: [messageId],
        resource: {
          removeLabelIds: ['UNREAD'],
          addLabelIds: [], // Could add a 'PROCESSED' label here if it exists
        },
      });
    } catch (error) {
      console.error(`Failed to mark message ${messageId} as read:`, error);
    }
  }
}
