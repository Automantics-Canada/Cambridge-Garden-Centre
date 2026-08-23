import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertDisposableQaDatabase } from './qaGuard.js';

function runNodeScript(script: string, args: string[]): void {
  const result = spawnSync(process.execPath, [path.resolve(script), ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(script)} exited with status ${result.status}`);
  }
}

assertDisposableQaDatabase();

// Use the locally installed CLIs so this command is deterministic and cannot
// prompt npm to download a different Prisma or tsx release.
runNodeScript('node_modules/prisma/build/index.js', [
  'migrate',
  'reset',
  '--force',
  '--skip-seed',
]);
runNodeScript('node_modules/tsx/dist/cli.mjs', ['src/scripts/seedQa.ts']);
