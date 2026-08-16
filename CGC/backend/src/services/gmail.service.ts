import { google } from 'googleapis';
import { env } from '../config/env.js';
import { InvoiceService } from '../modules/invoices/invoice.service.js';
import { prisma } from '../db/prisma.js';
import { triggerOcrProcessing } from './ocrJobProcessor.js';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.send'];

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
  private static isPolling = false;

  /** Message ids already reported as out-of-scope, so the warning logs once per process. */
  private static rejectedSenders = new Set<string>();

  /**
   * True when the sender is on the configured allowlist, matched on either the
   * full address or its domain. The allowlist is required, so an empty list
   * rejects everything rather than waving everything through.
   */
  private static isAllowedSender(from: string): boolean {
    const address = (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
    if (!address) return false;
    const domain = address.split('@')[1] ?? '';

    return env.gmailSenderAllowlist.some(
      entry => entry === address || entry === domain || (entry.startsWith('@') && entry.slice(1) === domain)
    );
  }

  /**
   * Polls the invoice mailbox for supplier invoices.
   *
   * Scope is deliberately narrow. The previous query was `is:unread
   * has:attachment` with no sender check, which made every unread message
   * carrying a PDF or image into an `Invoice` row — delivery tickets emailed by
   * drivers included, and unrelated mail in the same mailbox too. Polling now
   * requires both a label and a sender allowlist, and does nothing without them.
   */
  static async pollInvoices() {
    if (this.isPolling) {
      console.log('⏳ Gmail polling already in progress. Skipping...');
      return;
    }

    if (!env.gmailClientId || !env.gmailRefreshToken) {
      console.warn('⚠️ Gmail API credentials not fully configured. Skipping polling.', {
        hasClientId: !!env.gmailClientId,
        hasRefreshToken: !!env.gmailRefreshToken
      });
      return;
    }

    if (!env.gmailInvoiceLabel || env.gmailSenderAllowlist.length === 0) {
      console.warn(
        '⚠️ Gmail invoice polling is disabled: set GMAIL_INVOICE_LABEL and ' +
        'GMAIL_SENDER_ALLOWLIST to enable it. Polling without them ingests every ' +
        'unread attachment as a supplier invoice.'
      );
      return;
    }

    try {
      this.isPolling = true;
      console.log(`📬 Checking Gmail label "${env.gmailInvoiceLabel}" for new unread invoices...`);

      // Scoped to the invoice label so tickets and unrelated mail are never seen.
      const res = await this.gmail.users.messages.list({
        userId: 'me',
        q: `is:unread has:attachment label:${JSON.stringify(env.gmailInvoiceLabel)}`,
        maxResults: 10
      });

      const messages = res.data.messages || [];
      console.log(`Found ${messages.length} potential email(s) with attachments to check.`);

      for (const msg of messages) {
        await this.processMessage(msg.id!);
      }
    } catch (error) {
      console.error('❌ Error polling Gmail:', error);
    } finally {
      this.isPolling = false;
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

      // The label scopes the query, but a mislabelled message must not become an
      // invoice on the strength of the label alone. Left unread on purpose so a
      // human still sees it; warned once per process so the 60s poll stays quiet.
      if (!this.isAllowedSender(from)) {
        if (!this.rejectedSenders.has(messageId)) {
          this.rejectedSenders.add(messageId);
          console.warn(`Skipping labelled message from non-allowlisted sender ${from}: "${subject}"`);
        }
        return;
      }

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

        const buffer = Buffer.from(attachRes.data.data!, 'base64url');

        // Trigger Ingestion Pipeline
        console.log(`Ingesting attachment: ${attachment.filename}`);
        const result = await InvoiceService.ingestEmailInvoice({
          buffer,
          originalName: attachment.filename || 'invoice.pdf',
          fromEmail: from,
          subject: subject,
          gmailMessageId: compositeId
        });

        // Trigger OCR process automatically via unified background processor
        if (result.ocrJob.id) {
          triggerOcrProcessing(result.ocrJob.id);
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
      await this.gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: {
          removeLabelIds: ['UNREAD'],
        },
      });
    } catch (error) {
      console.error(`Failed to mark message ${messageId} as read:`, error);
    }
  }

  /**
   * Send an email using the connected Gmail account
   */
  static async sendEmail(to: string, subject: string, htmlBody: string) {
    if (!env.gmailClientId || !env.gmailRefreshToken) {
      console.warn('⚠️ Gmail API credentials not fully configured. Cannot send email.');
      return;
    }

    try {
      const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
      const messageParts = [
        `To: ${to}`,
        `Subject: ${utf8Subject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=utf-8',
        '',
        htmlBody,
      ];
      const message = messageParts.join('\r\n');
      const encodedMessage = Buffer.from(message)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedMessage,
        },
      });
      console.log(`Email sent successfully to ${to}`);
    } catch (error) {
      console.error(`❌ Error sending email to ${to}:`, error);
      throw error;
    }
  }
}

