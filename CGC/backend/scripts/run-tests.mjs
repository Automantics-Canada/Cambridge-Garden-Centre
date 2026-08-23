import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const mode = process.argv[2] ?? 'unit';
if (!['unit', 'integration'].includes(mode)) {
  console.error('Usage: node scripts/run-tests.mjs <unit|integration>');
  process.exit(2);
}

const testsRoot = path.resolve('tests');
const files = readdirSync(testsRoot)
  .filter(name => mode === 'integration'
    ? name.endsWith('.integration.test.ts')
    : name.endsWith('.test.ts') && !name.endsWith('.integration.test.ts'))
  .sort()
  .map(name => path.join(testsRoot, name));

if (mode === 'integration') {
  if (process.env.CGC_TEST_CONFIRM_DISPOSABLE !== '1') {
    console.error('Refusing integration tests without CGC_TEST_CONFIRM_DISPOSABLE=1');
    process.exit(2);
  }

  process.env.DATABASE_URL ||= 'postgresql://cgctest:cgctest@127.0.0.1:55432/cgc_integration';
  process.env.DIRECT_URL ||= process.env.DATABASE_URL;

  let databaseUrl;
  try {
    databaseUrl = new URL(process.env.DATABASE_URL ?? '');
  } catch {
    console.error('Integration tests require a valid DATABASE_URL');
    process.exit(2);
  }

  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(databaseUrl.hostname);
  const disposableName = databaseUrl.pathname === '/cgc_integration';
  if (!loopback || !disposableName) {
    console.error('Refusing integration tests: DATABASE_URL must target loopback/cgc_integration');
    process.exit(2);
  }
}

if (files.length === 0) {
  console.error(`No ${mode} test files found`);
  process.exit(2);
}

const result = spawnSync(
  process.execPath,
  [
    '--experimental-test-module-mocks',
    '--import',
    'tsx',
    '--test',
    ...(mode === 'integration' ? ['--test-concurrency=1'] : []),
    ...files,
  ],
  { stdio: 'inherit', env: process.env }
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
