/**
 * URL Handler Service
 * Utility functions for downloading files from URLs
 */
/**
 * Download file from URL and save to temporary location
 */
export declare function downloadFileToTemp(url: string, filename?: string): Promise<string>;
/**
 * Clean up temporary file
 */
export declare function cleanupTempFile(tempPath: string): Promise<void>;
/**
 * Check if URL is a Supabase Storage URL
 */
export declare function isSupabaseUrl(url: string): boolean;
/**
 * Get filename from URL or path
 */
export declare function getFilenameFromUrl(url: string): string;
declare const _default: {
    downloadFileToTemp: typeof downloadFileToTemp;
    cleanupTempFile: typeof cleanupTempFile;
    isSupabaseUrl: typeof isSupabaseUrl;
    getFilenameFromUrl: typeof getFilenameFromUrl;
};
export default _default;
//# sourceMappingURL=urlHandler.d.ts.map