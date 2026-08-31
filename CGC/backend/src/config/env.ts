import dotenv from 'dotenv';

dotenv.config();

const nodeEnv = process.env.NODE_ENV || 'development';
const storageDriver = process.env.STORAGE_DRIVER === 'local' ? 'local' : 'supabase';

if (storageDriver === 'local' && !['development', 'test'].includes(nodeEnv)) {
    throw new Error('STORAGE_DRIVER=local is allowed only in development or test');
}

if(!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
}

if(!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is required');
}

if(!process.env.INTERNAL_SHARED_SECRET) {
    throw new Error('INTERNAL_SHARED_SECRET is required and must be distinct from JWT_SECRET');
}

if(process.env.INTERNAL_SHARED_SECRET === process.env.JWT_SECRET) {
    throw new Error('INTERNAL_SHARED_SECRET must be distinct from JWT_SECRET');
}


if(storageDriver === 'supabase' && !process.env.SUPABASE_URL) {
    throw new Error('SUPABASE_URL is required');
}

if(storageDriver === 'supabase' && !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');
}

if(storageDriver === 'supabase' && !process.env.SUPABASE_STORAGE_BUCKET) {
    throw new Error('SUPABASE_STORAGE_BUCKET is required');
}

export const env = {
    nodeEnv,
    databaseUrl: process.env.DATABASE_URL!,
    jwtSecret: process.env.JWT_SECRET!,
    port: Number(process.env.PORT) || 3000,
    storageDriver,
    supabaseUrl: process.env.SUPABASE_URL || 'http://127.0.0.1:54321',
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || 'local-test-service-role-key',
    supabaseStorageBucket: process.env.SUPABASE_STORAGE_BUCKET || 'local-test-bucket',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    awsRegion: process.env.AWS_REGION || 'us-east-1',
    /**
     * The structured-extraction fallback.
     *
     * Textract remains the OCR provider; this only fills fields the deterministic
     * extractors could not resolve. None of it is required to boot: an API
     * process missing GROQ_API_KEY starts normally and every document that would
     * have used the fallback is marked NEEDS_REVIEW instead.
     *
     * The key belongs in the Railway backend and worker secrets only. It must
     * never reach the frontend build, which is public.
     */
    groqApiKey: process.env.GROQ_API_KEY || '',
    groqModel: process.env.GROQ_MODEL || 'openai/gpt-oss-20b',
    /**
     * Off unless explicitly switched on. A key present in the environment is not
     * on its own permission to start spending against it — staging and
     * production share secrets often enough that key-presence-implies-enabled
     * would silently turn the fallback on wherever the secret was copied.
     */
    groqFallbackEnabled: process.env.GROQ_FALLBACK_ENABLED === 'true',
    groqTimeoutMs: Number(process.env.GROQ_TIMEOUT_MS) || 20_000,
    groqMaxOutputTokens: Number(process.env.GROQ_MAX_OUTPUT_TOKENS) || 1_200,
    /** Ceiling on simultaneous fallback calls from one worker sweep. */
    groqMaxConcurrency: Number(process.env.GROQ_MAX_CONCURRENCY) || 2,
    gmailClientId: process.env.GMAIL_CLIENT_ID || '',
    gmailClientSecret: process.env.GMAIL_CLIENT_SECRET || '',
    gmailRefreshToken: process.env.GMAIL_REFRESH_TOKEN || '',
    /**
     * Scope for the invoice inbox poller. Both are required before any polling
     * happens: without them the poller treated every unread message carrying an
     * attachment as a supplier invoice, including delivery tickets and unrelated
     * personal mail.
     *
     * GMAIL_INVOICE_LABEL      a Gmail label applied to supplier invoice mail
     * GMAIL_SENDER_ALLOWLIST   comma-separated sender domains or addresses
     */
    gmailInvoiceLabel: process.env.GMAIL_INVOICE_LABEL || '',
    gmailSenderAllowlist: (process.env.GMAIL_SENDER_ALLOWLIST || '')
        .split(',')
        .map(entry => entry.trim().toLowerCase())
        .filter(Boolean),
    internalSharedSecret: process.env.INTERNAL_SHARED_SECRET!,
}
