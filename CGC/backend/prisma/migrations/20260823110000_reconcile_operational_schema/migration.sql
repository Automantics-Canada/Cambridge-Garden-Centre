-- Reconcile operational schema objects that are present in the Prisma model
-- and in the running application, but were never represented by a committed
-- forward migration. This migration is intentionally safe both for a database
-- created only from this repository's migration chain and for an environment
-- where some or all of these objects were previously created by `prisma db
-- push`. Existing columns and indexes are never rewritten.

DO $$ BEGIN
  CREATE TYPE "DriverTaskStatus" AS ENUM ('NOT_STARTED', 'AT_SUPPLIER', 'IN_TRANSIT', 'COMPLETED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "DriverType" AS ENUM ('CGC_FLEET', 'INDEPENDENT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "DeliveryStatus" AS ENUM ('UNASSIGNED', 'PLACED', 'OUT_FOR_DELIVERY', 'IN_TRANSIT', 'DELIVERED', 'ON_HOLD', 'DELAYED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE "AuditActionType" ADD VALUE IF NOT EXISTS 'INVOICE_LINE_OVERRIDDEN';
ALTER TYPE "TicketSource" ADD VALUE IF NOT EXISTS 'MANUAL';

ALTER TABLE "Driver"
  ADD COLUMN IF NOT EXISTS "companyName" TEXT,
  ADD COLUMN IF NOT EXISTS "email" TEXT,
  ADD COLUMN IF NOT EXISTS "ratePerDelivery" DECIMAL NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "ratePerTrip" DECIMAL,
  ADD COLUMN IF NOT EXISTS "type" "DriverType" NOT NULL DEFAULT 'CGC_FLEET',
  ADD COLUMN IF NOT EXISTS "userId" UUID;

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "deliveryStatus" "DriverTaskStatus" NOT NULL DEFAULT 'NOT_STARTED',
  ADD COLUMN IF NOT EXISTS "driverId" UUID,
  ADD COLUMN IF NOT EXISTS "priority" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "Ticket"
  ADD COLUMN IF NOT EXISTS "deliveryStatus" "DriverTaskStatus" NOT NULL DEFAULT 'NOT_STARTED',
  ADD COLUMN IF NOT EXISTS "spruceMatched" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "supplierName" TEXT;

ALTER TABLE "InvoiceLineItem"
  ADD COLUMN IF NOT EXISTS "approvedTotal" DECIMAL,
  ADD COLUMN IF NOT EXISTS "isOverridden" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "overrideNote" TEXT;

CREATE TABLE IF NOT EXISTS "TicketOrderMatch" (
  "id" UUID NOT NULL,
  "ticketId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "matchMethod" TEXT NOT NULL,
  "matchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdBy" UUID,
  CONSTRAINT "TicketOrderMatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Delivery" (
  "id" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "driverId" UUID,
  "status" "DeliveryStatus" NOT NULL DEFAULT 'UNASSIGNED',
  "priority" INTEGER NOT NULL DEFAULT 1,
  "pickupType" TEXT NOT NULL DEFAULT 'EXTERNAL',
  "pickupPhotoUrl" TEXT,
  "deliveryPhotoUrl" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Product" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "unit" TEXT NOT NULL DEFAULT 'ton',
  CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Unit" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Unit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DeliveryHistory" (
  "id" UUID NOT NULL,
  "deliveryId" UUID NOT NULL,
  "status" "DeliveryStatus" NOT NULL,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeliveryHistory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "_InvoiceLineItemToTicket" (
  "A" UUID NOT NULL,
  "B" UUID NOT NULL,
  CONSTRAINT "_InvoiceLineItemToTicket_AB_pkey" PRIMARY KEY ("A", "B")
);

-- Preserve every legacy one-to-one ticket link before moving to Prisma's
-- many-to-many join. Environments previously aligned with `db push` no longer
-- have matchedTicketId, so the guarded dynamic statement is a no-op there.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'InvoiceLineItem'
      AND column_name = 'matchedTicketId'
  ) THEN
    EXECUTE '
      INSERT INTO "_InvoiceLineItemToTicket" ("A", "B")
      SELECT "id", "matchedTicketId"
      FROM "InvoiceLineItem"
      WHERE "matchedTicketId" IS NOT NULL
      ON CONFLICT DO NOTHING
    ';
    ALTER TABLE "InvoiceLineItem" DROP CONSTRAINT IF EXISTS "InvoiceLineItem_matchedTicketId_fkey";
    ALTER TABLE "InvoiceLineItem" DROP COLUMN "matchedTicketId";
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "TicketOrderMatch_ticketId_orderId_key" ON "TicketOrderMatch" ("ticketId", "orderId");
CREATE INDEX IF NOT EXISTS "TicketOrderMatch_matchMethod_idx" ON "TicketOrderMatch" ("matchMethod");
CREATE INDEX IF NOT EXISTS "TicketOrderMatch_orderId_idx" ON "TicketOrderMatch" ("orderId");
CREATE INDEX IF NOT EXISTS "TicketOrderMatch_ticketId_idx" ON "TicketOrderMatch" ("ticketId");
CREATE UNIQUE INDEX IF NOT EXISTS "Product_name_key" ON "Product" ("name");
CREATE UNIQUE INDEX IF NOT EXISTS "Unit_name_key" ON "Unit" ("name");
CREATE INDEX IF NOT EXISTS "_InvoiceLineItemToTicket_B_index" ON "_InvoiceLineItemToTicket" ("B");
CREATE UNIQUE INDEX IF NOT EXISTS "Driver_email_key" ON "Driver" ("email");
CREATE UNIQUE INDEX IF NOT EXISTS "Driver_userId_key" ON "Driver" ("userId");
CREATE INDEX IF NOT EXISTS "Invoice_status_idx" ON "Invoice" ("status");
CREATE INDEX IF NOT EXISTS "Invoice_supplierId_idx" ON "Invoice" ("supplierId");
CREATE INDEX IF NOT EXISTS "Invoice_receivedAt_idx" ON "Invoice" ("receivedAt");
CREATE INDEX IF NOT EXISTS "InvoiceLineItem_invoiceId_idx" ON "InvoiceLineItem" ("invoiceId");
CREATE INDEX IF NOT EXISTS "InvoiceLineItem_poNumber_idx" ON "InvoiceLineItem" ("poNumber");
CREATE INDEX IF NOT EXISTS "Order_poNumber_idx" ON "Order" ("poNumber");
CREATE INDEX IF NOT EXISTS "Order_supplierId_idx" ON "Order" ("supplierId");
CREATE INDEX IF NOT EXISTS "Order_orderDate_idx" ON "Order" ("orderDate");
CREATE INDEX IF NOT EXISTS "Ticket_status_idx" ON "Ticket" ("status");
CREATE INDEX IF NOT EXISTS "Ticket_poNumber_idx" ON "Ticket" ("poNumber");
CREATE INDEX IF NOT EXISTS "Ticket_supplierId_idx" ON "Ticket" ("supplierId");
CREATE INDEX IF NOT EXISTS "Ticket_receivedAt_idx" ON "Ticket" ("receivedAt");

DO $$ BEGIN
  ALTER TABLE "Order" ADD CONSTRAINT "Order_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "TicketOrderMatch" ADD CONSTRAINT "TicketOrderMatch_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "TicketOrderMatch" ADD CONSTRAINT "TicketOrderMatch_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "Driver" ADD CONSTRAINT "Driver_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "DeliveryHistory" ADD CONSTRAINT "DeliveryHistory_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "Delivery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "_InvoiceLineItemToTicket" ADD CONSTRAINT "_InvoiceLineItemToTicket_A_fkey" FOREIGN KEY ("A") REFERENCES "InvoiceLineItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "_InvoiceLineItemToTicket" ADD CONSTRAINT "_InvoiceLineItemToTicket_B_fkey" FOREIGN KEY ("B") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
