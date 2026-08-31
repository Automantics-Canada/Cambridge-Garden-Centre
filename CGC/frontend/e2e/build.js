import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertE2eOptIn, frontendQaEnv } from './qa-env.js';

assertE2eOptIn();

const result = spawnSync(
  process.execPath,
  [path.resolve('node_modules/vite/bin/vite.js'), 'build'],
  { cwd: process.cwd(), env: frontendQaEnv, stdio: 'inherit' },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
