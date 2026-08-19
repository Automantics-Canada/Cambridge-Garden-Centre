-- Legacy imports wrote a small number of orders without a buyer type or
-- quantity or unit. Production already stores these columns as nullable; this migration
-- records that contract for clean databases and keeps Prisma from rejecting a
-- whole result set when one historical row is incomplete.
ALTER TABLE public."Order"
  ALTER COLUMN "buyerType" DROP NOT NULL,
  ALTER COLUMN "buyerType" SET DEFAULT 'CONTRACTOR',
  ALTER COLUMN "quantity" DROP NOT NULL,
  ALTER COLUMN "unit" DROP NOT NULL;
