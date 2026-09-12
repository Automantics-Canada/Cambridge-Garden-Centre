import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';

/**
 * Runs the extraction accuracy eval with only an API key.
 *
 * The eval reads documents and scores fields. It never opens a database or
 * touches storage — but it imports the extraction service, which imports
 * config/env.ts, which validates the *whole* environment at load time and
 * throws on a missing DATABASE_URL.
 *
 * That is a small obstacle with a large effect: measuring accuracy has been one
 * unexplained crash away from happening since the eval was written, and it has
 * never been run. Placeholders for the values extraction does not use remove
 * the obstacle, and a missing OPENAI_API_KEY is reported as the one thing that
 * genuinely is required.
 *
 *   OPENAI_API_KEY=... npm run extraction:eval
 *
 * Put the key in CGC/backend/.env (gitignored) rather than passing it on a
 * command line, where it lands in shell history.
 */

if (!process.env.OPENAI_API_KEY) {
  // dotenv has not run yet; config/env.ts loads .env when it is imported.
  const hasDotEnv = (() => {
    try {
      return /^OPENAI_API_KEY=.+/m.test(fs.readFileSync('.env', 'utf8'));
    } catch {
      return false;
    }
  })();

  if (!hasDotEnv) {
    console.error(
      'OPENAI_API_KEY is not set.\n\n' +
        'Put it in CGC/backend/.env (which is gitignored):\n' +
        '    OPENAI_API_KEY=sk-...\n\n' +
        'The eval calls the extraction provider for real, so it needs a genuine key.'
    );
    process.exit(2);
  }
}

// Values extraction never reads. Present only so the environment validator,
// which checks everything the server needs, does not stop a scoring run.
const placeholders = {
  DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
  DIRECT_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
  JWT_SECRET: 'unused-for-the-eval',
  SUPABASE_URL: 'https://unused.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'unused-for-the-eval',
  SUPABASE_STORAGE_BUCKET: 'unused',
};

for (const [key, value] of Object.entries(placeholders)) {
  process.env[key] ||= value;
}

process.env.EXTRACTION_EVAL_DIR ||= '.extraction-eval';

const result = spawnSync('npx', ['tsx', 'src/scripts/extractionEval.ts'], {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);
