-- Records every truck load dispatch sends, with the haul rate agreed for it.
--
-- WHY
--
-- The client (22/10/2026, Q14): trucking invoices vary, so they want "a spot
-- for a rate on every single dispatch load. The dispatcher sets the rate for
-- each load dispatched and it is matched up when the invoice comes in." Each
-- row here is one load of one order: who hauled it (a trucking company, or
-- nobody for CGC's own trucks), the rate and whether it is per load, hour or
-- tonne, the expected quantity, the pit it is collected at (Q5: defaults to
-- the order's pit), the trip it belongs to when one brokered truck collects
-- several orders' POs (Q4), and the ticket once known. Matching trucking
-- invoices against these rows comes in a later change; "claimedByLineItemId"
-- is the line that paid the load, so a haul is paid once.
--
-- The four audit actions record who set or changed a load and its rate.
--
-- SAFETY
--
-- Additive: one enum, four enum values and one new table, read and written
-- only by the API's server-side connection. Nothing existing changes. Rows
-- hang off OrderDocument with ON DELETE CASCADE, so removing orders removes
-- their loads; a removed stop, driver, pit or invoice line only clears its
-- key. A carrier is never cleared (ON DELETE RESTRICT): suppliers are only
-- ever deactivated, and a paid haul must keep who hauled it. The CHECKs keep
-- the figures sane even for a write that bypasses the API. Browser roles get
-- no access, as every other table.
--
-- The three known `DROP DEFAULT` differences recorded in
-- 20260907100000_reconcile_operational_schema are left out on purpose.

-- CreateEnum
CREATE TYPE "HaulRateUnit" AS ENUM ('LOAD', 'HOUR', 'TONNE');

-- AlterEnum
ALTER TYPE "AuditActionType" ADD VALUE 'LOAD_CREATED';
ALTER TYPE "AuditActionType" ADD VALUE 'LOAD_UPDATED';
ALTER TYPE "AuditActionType" ADD VALUE 'LOAD_RATE_SET';
ALTER TYPE "AuditActionType" ADD VALUE 'LOAD_DELETED';

-- CreateTable
CREATE TABLE "DispatchLoad" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "deliveryId" UUID,
    "sequence" INTEGER NOT NULL,
    "carrierSupplierId" UUID,
    "driverId" UUID,
    "rate" DECIMAL(12,4),
    "rateUnit" "HaulRateUnit",
    "quantity" DECIMAL(12,4),
    "sourceSupplierId" UUID,
    "tripRef" TEXT,
    "ticketNumber" TEXT,
    "notes" TEXT,
    "setById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "claimedByLineItemId" UUID,
    "claimedAt" TIMESTAMP(3),

    CONSTRAINT "DispatchLoad_pkey" PRIMARY KEY ("id")
);

-- A rate is never negative and always says what it is per; quantities are
-- positive; loads are numbered from 1.
ALTER TABLE "DispatchLoad" ADD CONSTRAINT "DispatchLoad_rate_check" CHECK ("rate" IS NULL OR "rate" >= 0);
ALTER TABLE "DispatchLoad" ADD CONSTRAINT "DispatchLoad_rateUnit_check" CHECK ("rate" IS NULL OR "rateUnit" IS NOT NULL);
ALTER TABLE "DispatchLoad" ADD CONSTRAINT "DispatchLoad_quantity_check" CHECK ("quantity" IS NULL OR "quantity" > 0);
ALTER TABLE "DispatchLoad" ADD CONSTRAINT "DispatchLoad_sequence_check" CHECK ("sequence" >= 1);

-- CreateIndex
CREATE INDEX "DispatchLoad_carrierSupplierId_createdAt_idx" ON "DispatchLoad"("carrierSupplierId", "createdAt");

-- CreateIndex
CREATE INDEX "DispatchLoad_tripRef_idx" ON "DispatchLoad"("tripRef");

-- CreateIndex
CREATE INDEX "DispatchLoad_claimedByLineItemId_idx" ON "DispatchLoad"("claimedByLineItemId");

-- CreateIndex
CREATE INDEX "DispatchLoad_deliveryId_idx" ON "DispatchLoad"("deliveryId");

-- CreateIndex (also serves lookups by order: documentId leads)
CREATE UNIQUE INDEX "DispatchLoad_documentId_sequence_key" ON "DispatchLoad"("documentId", "sequence");

-- AddForeignKey
ALTER TABLE "DispatchLoad" ADD CONSTRAINT "DispatchLoad_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "OrderDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchLoad" ADD CONSTRAINT "DispatchLoad_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "Delivery"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchLoad" ADD CONSTRAINT "DispatchLoad_carrierSupplierId_fkey" FOREIGN KEY ("carrierSupplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchLoad" ADD CONSTRAINT "DispatchLoad_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchLoad" ADD CONSTRAINT "DispatchLoad_sourceSupplierId_fkey" FOREIGN KEY ("sourceSupplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchLoad" ADD CONSTRAINT "DispatchLoad_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchLoad" ADD CONSTRAINT "DispatchLoad_claimedByLineItemId_fkey" FOREIGN KEY ("claimedByLineItemId") REFERENCES "InvoiceLineItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Lock down the new table: no policies for browser roles, as elsewhere.
ALTER TABLE public."DispatchLoad" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public."DispatchLoad" FROM anon, authenticated;
