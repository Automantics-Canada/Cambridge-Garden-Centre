import dotenv from 'dotenv';

dotenv.config();

if(!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
}

if(!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is required');
}


if(!process.env.SUPABASE_URL) {
    throw new Error('SUPABASE_URL is required');
}

if(!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');
}

if(!process.env.SUPABASE_STORAGE_BUCKET) {
    throw new Error('SUPABASE_STORAGE_BUCKET is required');
}

if(!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required');
}

export const env = {
    nodeEnv: process.env.NODE_ENV || 'development',
    databaseUrl: process.env.DATABASE_URL!,
    jwtSecret: process.env.JWT_SECRET!,
    port: Number(process.env.PORT) || 3000,
    supabaseUrl: process.env.SUPABASE_URL!,
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    supabaseStorageBucket: process.env.SUPABASE_STORAGE_BUCKET!,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    openaiApiKey: process.env.OPENAI_API_KEY!,
    /**
     * The model that reads delivery tickets and supplier invoices.
     *
     * `gpt-5.6-luna` is OpenAI's cost-tier model with image input, file input
     * and structured outputs — at $0.20/$1.20 per million tokens, reading every
     * document CGC handles in a month costs a couple of dollars. Cost is not
     * what should decide this: extraction accuracy is what the whole
     * pay-only-for-what-arrived chain rests on, so change it on the evidence of
     * `npm run extraction:eval`, not on price.
     */
    openaiModelId: process.env.OPENAI_MODEL_ID || 'gpt-5.6-luna',
    /**
     * Who reads the morning's Spruce reports (see readSprucePages).
     *
     * ai      the model reads every report: the default. The layout reader
     *         reads one only where the model cannot answer (no credit, down).
     * both    the layout reader and the model, compared line by line. Each
     *         catches the other's mistakes, and either carries the import
     *         when the other cannot.
     * auto    the layout reader; the model only where it fails
     * parser  the layout reader alone, never the model
     */
    spruceReader: (['both', 'auto', 'ai', 'parser'].includes(process.env.SPRUCE_READER ?? '')
        ? process.env.SPRUCE_READER
        : 'ai') as 'both' | 'auto' | 'ai' | 'parser',
    /**
     * The model that reads Spruce reports, and how hard it reasons.
     *
     * Benchmarked on every report on file (Aug 14, Oct 13, Oct 21), each read
     * over and over: gpt-6.1-sol read 40 reports without a single wrong value
     * at its default reasoning; the invoice model, gpt-5.6-luna, misread
     * something in a third of its runs. Low reasoning is the owner's choice,
     * for speed and cost. SPRUCE_AI_REASONING_EFFORT takes minimal, low,
     * medium or high; 'default' sends none, so the model reasons as it did in
     * the benchmark.
     */
    spruceAiModelId: process.env.SPRUCE_AI_MODEL_ID || 'gpt-6.1-sol',
    spruceAiReasoningEffort: (['minimal', 'low', 'medium', 'high'].includes(process.env.SPRUCE_AI_REASONING_EFFORT ?? 'low')
        ? process.env.SPRUCE_AI_REASONING_EFFORT ?? 'low'
        : undefined) as 'minimal' | 'low' | 'medium' | 'high' | undefined,
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
    internalSharedSecret: process.env.INTERNAL_SHARED_SECRET || process.env.JWT_SECRET!,
}