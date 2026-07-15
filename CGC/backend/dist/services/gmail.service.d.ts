export declare class GmailService {
    private static auth;
    private static gmail;
    private static isPolling;
    /**
     * Polls Gmail for new unread messages in ap@cambridgegardencentre.ca
     */
    static pollInvoices(): Promise<void>;
    private static processMessage;
    private static getAttachments;
    private static markAsRead;
    /**
     * Send an email using the connected Gmail account
     */
    static sendEmail(to: string, subject: string, htmlBody: string): Promise<void>;
}
//# sourceMappingURL=gmail.service.d.ts.map