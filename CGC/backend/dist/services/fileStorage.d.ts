/**
 * Save a ticket image buffer to /uploads/tickets and return its public path.
 * Later you can swap this out for R2/S3 with the same function signature.
 */
export declare function saveTicketImage(buffer: Buffer, originalName: string): Promise<string>;
//# sourceMappingURL=fileStorage.d.ts.map