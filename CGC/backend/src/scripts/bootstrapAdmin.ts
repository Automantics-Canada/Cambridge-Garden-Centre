/**
 * Offline ADMIN bootstrap / recovery.
 *
 * `POST /api/auth/register` now requires an authenticated ADMIN, which closes
 * the privilege-escalation hole but leaves no way to create the first ADMIN,
 * or to recover if every ADMIN account is lost or disabled. This script is that
 * path. It is deliberately a CLI, not an HTTP route, so it is only reachable by
 * an operator who already holds database credentials.
 *
 * Credentials are read from the environment rather than argv so the password
 * does not land in shell history or the process list.
 *
 *   BOOTSTRAP_ADMIN_EMAIL=ops@example.com \
 *   BOOTSTRAP_ADMIN_NAME="Ops Admin" \
 *   BOOTSTRAP_ADMIN_PASSWORD='<generated>' \
 *   npm run bootstrap:admin
 *
 * Safety behaviour:
 *   - Refuses to run without an explicit email, name and password.
 *   - Requires at least 12 characters; there is no default password anywhere.
 *   - If an active ADMIN already exists it makes no change and exits 0, unless
 *     BOOTSTRAP_ADMIN_ALLOW_ADDITIONAL=true. Whether production has one is
 *     treated as unknown, so the script is safe to run either way.
 *   - If the target email already exists it will not silently take the account
 *     over; promotion/password reset requires BOOTSTRAP_ADMIN_PROMOTE=true.
 *   - Never logs the password.
 */
import bcrypt from 'bcryptjs';
import { prisma } from '../db/prisma.js';

const BCRYPT_ROUNDS = 10; // matches AuthService.register
const MIN_PASSWORD_LENGTH = 12;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function isTruthy(name: string): boolean {
  return (process.env[name] || '').trim().toLowerCase() === 'true';
}

async function main() {
  const email = requireEnv('BOOTSTRAP_ADMIN_EMAIL').toLowerCase();
  const name = requireEnv('BOOTSTRAP_ADMIN_NAME');
  const password = requireEnv('BOOTSTRAP_ADMIN_PASSWORD');

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('BOOTSTRAP_ADMIN_EMAIL is not a valid email address');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`BOOTSTRAP_ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.toLowerCase() === email || password.toLowerCase().includes('password')) {
    throw new Error('BOOTSTRAP_ADMIN_PASSWORD is too predictable');
  }

  const allowAdditional = isTruthy('BOOTSTRAP_ADMIN_ALLOW_ADDITIONAL');
  const allowPromote = isTruthy('BOOTSTRAP_ADMIN_PROMOTE');

  const existingAdmins = await prisma.user.count({
    where: { role: 'ADMIN', active: true },
  });

  const existingUser = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true, active: true },
  });

  if (existingAdmins > 0 && !existingUser && !allowAdditional) {
    console.log(
      `An active ADMIN already exists (${existingAdmins} found). No change made. ` +
      'Set BOOTSTRAP_ADMIN_ALLOW_ADDITIONAL=true to create another ADMIN anyway.'
    );
    return;
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  if (existingUser) {
    if (!allowPromote) {
      throw new Error(
        `A user already exists for ${email} (role ${existingUser.role}, active ${existingUser.active}). ` +
        'Set BOOTSTRAP_ADMIN_PROMOTE=true to promote it to ADMIN and reset its password.'
      );
    }
    await prisma.user.update({
      where: { id: existingUser.id },
      data: { role: 'ADMIN', active: true, passwordHash, name },
    });
    console.log(`Promoted ${email} to an active ADMIN and reset its password.`);
    return;
  }

  const created = await prisma.user.create({
    data: { email, name, role: 'ADMIN', active: true, passwordHash },
    select: { id: true, email: true },
  });
  console.log(`Created ADMIN ${created.email} (${created.id}).`);
}

main()
  .catch((error) => {
    console.error('Admin bootstrap failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
