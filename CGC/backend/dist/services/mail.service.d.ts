export declare const MailService: {
    sendEmail(to: string, subject: string, text: string, html?: string): Promise<{
        success: boolean;
        messageId: any;
        error?: never;
    } | {
        success: boolean;
        error: any;
        messageId?: never;
    }>;
    sendAssignmentEmail(driverId: string, deliveryId: string): Promise<{
        success: boolean;
        messageId: any;
        error?: never;
    } | {
        success: boolean;
        error: any;
        messageId?: never;
    }>;
    sendPriorityUpdateEmail(driverId: string): Promise<{
        success: boolean;
        messageId: any;
        error?: never;
    } | {
        success: boolean;
        error: any;
        messageId?: never;
    }>;
};
//# sourceMappingURL=mail.service.d.ts.map