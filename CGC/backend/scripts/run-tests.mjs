import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

/**
 * Runs the unit suite and the integration suite as separate passes.
 *
 * They cannot share one run. `tsx --test tests/**` executes files in parallel,
 * and the integration tests TRUNCATE tables — so an integration file would wipe
 * the database from under another one mid-flight. That is why
 * `orderPdfImport.integration.test.ts` has been failing in the combined run for
 * weeks while passing perfectly on its own: not a broken test, a broken way of
 * running it.
 *
 * Integration mode refuses to touch anything but a loopback database, because
 * the tests it runs start by deleting every row. The guard is deliberately
 * dumb and unskippable: a wrong DATABASE_URL here would empty production.
 *
 *   node scripts/run-tests.mjs unit
 *   CGC_TEST_CONFIRM_DISPOSABLE=1 node scripts/run-tests.mjs integration
 */

const mode = process.argv[2] ?? 'unit';
if (!['unit', 'integration'].includes(mode)) {
  console.error('Usage: node scripts/run-tests.mjs <unit|integration>');
  process.exit(2);
}

const testsRoot = path.resolve('tests');
const isIntegration = (name) => name.endsWith('.integration.test.ts');

const files = readdirSync(testsRoot)
  .filter((name) =>
    name.endsWith('.test.ts') && (mode === 'integration' ? isIntegration(name) : !isIntegration(name))
  )
  .sort()
  .map((name) => path.join('tests', name));

if (files.length === 0) {
  console.error(`No ${mode} test files found`);
  process.exit(2);
}

if (mode === 'integration') {
  if (process.env.CGC_TEST_CONFIRM_DISPOSABLE !== '1') {
    console.error(
      'Refusing to run integration tests without CGC_TEST_CONFIRM_DISPOSABLE=1.\n' +
        'They delete every row in the database they are pointed at.'
    );
    process.exit(2);
  }

  let url;
  try {
    url = new URL(process.env.DATABASE_URL ?? '');
  } catch {
    console.error('Integration tests need a valid DATABASE_URL');
    process.exit(2);
  }

  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    console.error(
      `Refusing to run integration tests against ${url.hostname}. ` +
        'They are destructive and only ever run against a loopback database.'
    );
    process.exit(2);
  }
}

if (mode === 'integration') {
  // One suite predates this runner and reads its own guard name. The loopback
  // and confirmation checks above have already passed, so it is set here rather
  // than asking every caller to remember two spellings of the same intent.
  process.env.SPRUCE_TEST_CONFIRM_DISPOSABLE = '1';
}

console.log(`Running ${files.length} ${mode} test file${files.length === 1 ? '' : 's'}`);

// Serial for integration: they share one database, so running them in parallel
// reintroduces exactly the interference this script exists to remove.
const args = ['--test', ...(mode === 'integration' ? ['--test-concurrency=1'] : []), ...files];
const result = spawnSync('npx', ['tsx', ...args], { stdio: 'inherit', shell: process.platform === 'win32' });

process.exit(result.status ?? 1);
