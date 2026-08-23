const databaseUrl = process.env.DATABASE_URL
  || 'postgresql://cgctest:cgctest@127.0.0.1:55432/cgc_integration';

export function assertE2eOptIn() {
  if (process.env.CGC_TEST_CONFIRM_DISPOSABLE !== '1') {
    throw new Error(
      'Refusing Playwright database reset without CGC_TEST_CONFIRM_DISPOSABLE=1',
    );
  }

  const url = new URL(databaseUrl);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
      || url.pathname !== '/cgc_integration') {
    throw new Error('Playwright DATABASE_URL must target loopback/cgc_integration');
  }
}

export const backendQaEnv = {
  ...process.env,
  NODE_ENV: 'test',
  PORT: '4000',
  DATABASE_URL: databaseUrl,
  DIRECT_URL: process.env.DIRECT_URL || databaseUrl,
  CGC_TEST_CONFIRM_DISPOSABLE: process.env.CGC_TEST_CONFIRM_DISPOSABLE || '',
  JWT_SECRET: process.env.JWT_SECRET || 'qa-only-jwt-secret-never-deploy',
  INTERNAL_SHARED_SECRET: process.env.INTERNAL_SHARED_SECRET || 'qa-only-internal-secret-never-deploy',
  STORAGE_DRIVER: 'local',
  WORKER_MODE: 'off',
  CORS_ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
  SUPABASE_URL: process.env.SUPABASE_URL || 'https://qa-local.invalid',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || 'qa-local-placeholder',
  SUPABASE_STORAGE_BUCKET: process.env.SUPABASE_STORAGE_BUCKET || 'qa-local',
  GROQ_FALLBACK_ENABLED: 'false',
};

export const frontendQaEnv = {
  ...process.env,
  // The aggregate backend gate runs with NODE_ENV=test. Do not let that leak
  // into the Vite bundle: React's development StrictMode intentionally runs
  // mount effects twice and is not representative of the deployed preview.
  NODE_ENV: 'production',
  VITE_API_URL: 'http://127.0.0.1:4000',
};
