-- The Prisma schema and driver account service both use DRIVER, but the
-- original UserRole enum migration only created AP_USER, OWNER, and ADMIN.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'DRIVER';
