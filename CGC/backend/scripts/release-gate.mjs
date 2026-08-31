import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const backend = process.cwd();
const frontend = path.resolve(backend, '../frontend');

function run(command, args, cwd = backend) {
  const windowsShim = process.platform === 'win32' && ['npm', 'npx'].includes(command);
  const executable = windowsShim ? (process.env.ComSpec || 'cmd.exe') : command;
  const commandArgs = windowsShim
    ? ['/d', '/s', '/c', `${command}.cmd`, ...args]
    : args;
  const result = spawnSync(executable, commandArgs, { cwd, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with ${result.status}`);
  }
}

if (process.env.CGC_TEST_CONFIRM_DISPOSABLE !== '1') {
  throw new Error('Release gate requires CGC_TEST_CONFIRM_DISPOSABLE=1');
}
process.env.DATABASE_URL ||= 'postgresql://cgctest:cgctest@127.0.0.1:55432/cgc_integration';
const database = new URL(process.env.DATABASE_URL);
if (!['127.0.0.1', 'localhost', '::1'].includes(database.hostname)
    || database.pathname !== '/cgc_integration') {
  throw new Error('Release gate DATABASE_URL must target loopback/cgc_integration');
}

// These values exist only inside the explicitly confirmed disposable gate.
// Production still fails closed in env.ts when either real secret is absent.
process.env.NODE_ENV = 'test';
process.env.STORAGE_DRIVER = 'local';
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.JWT_SECRET ||= 'qa-only-release-jwt-never-deploy';
process.env.INTERNAL_SHARED_SECRET ||= 'qa-only-release-internal-never-deploy';

run('npm', ['ci']);
run('npm', ['run', 'qa:prepare']);
run('npx', ['prisma', 'validate']);
run('npx', ['prisma', 'generate']);
run('npx', [
  'prisma', 'migrate', 'diff',
  '--from-url', process.env.DIRECT_URL || process.env.DATABASE_URL,
  '--to-schema-datamodel', 'prisma/schema.prisma',
  '--exit-code',
]);
run('npm', ['run', 'test:unit']);
run('npm', ['run', 'test:integration']);
run('npm', ['run', 'build']);
run('npm', ['audit', '--audit-level=high']);

run('npm', ['ci'], frontend);
run('npm', ['run', 'lint'], frontend);
run('npm', ['test'], frontend);
run('npm', ['audit', '--audit-level=high'], frontend);
run('npm', ['run', 'test:e2e'], frontend);

run('git', ['diff', '--check'], path.resolve(backend, '../..'));
console.log('CGC aggregate release gate passed.');
