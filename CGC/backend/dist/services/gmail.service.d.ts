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
}
//# sourceMappingURL=gmail.service.d.ts.map