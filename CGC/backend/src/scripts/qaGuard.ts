export function assertDisposableQaDatabase(): void {
  if (process.env.CGC_TEST_CONFIRM_DISPOSABLE !== '1') {
    throw new Error('Refusing QA database mutation without CGC_TEST_CONFIRM_DISPOSABLE=1');
  }

  let databaseUrl: URL;
  try {
    databaseUrl = new URL(process.env.DATABASE_URL ?? '');
  } catch {
    throw new Error('QA requires a valid DATABASE_URL');
  }

  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(databaseUrl.hostname);
  if (!loopback || databaseUrl.pathname !== '/cgc_integration') {
    throw new Error('QA database must be loopback/cgc_integration');
  }

  if ((process.env.NODE_ENV ?? 'development') === 'production') {
    throw new Error('QA database tooling is disabled in production');
  }
}
