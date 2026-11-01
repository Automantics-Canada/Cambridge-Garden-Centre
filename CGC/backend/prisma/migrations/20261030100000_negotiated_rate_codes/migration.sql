-- Lets a supplier's price list be loaded safely, and records what changed.
--
-- WHY
--
-- The client is about to send price lists. Rates were keyed on the product
-- name alone and a new price overwrote the old one in place, so an invoice
-- dated before the new price lost its rate. Rates are now one row per period:
-- the old period is closed the day before the new one starts. A price list can
-- carry the Spruce item code and the supplier's own code for each product, so
-- those are stored beside the rate. `updatedAt` says when a rate last changed.
--
-- Rates that were used are expired (their end date set) rather than deleted,
-- and Spruce vendor codes can now be mapped from the Supplier page instead of a
-- script. Both are audited, hence the three new audit actions.
--
-- SAFETY
--
-- Additive: three enum values, three nullable columns and two indexes on an
-- existing table. Existing rows keep their values; `updatedAt` stays null on
-- them until they next change. No new table, so no new row-level security is
-- needed: NegotiatedRate is already locked down for browser roles.
--
-- The three known `DROP DEFAULT` differences recorded in
-- 20260907100000_reconcile_operational_schema are left out on purpose.

-- AlterEnum
ALTER TYPE "AuditActionType" ADD VALUE 'RATE_EXPIRED';
ALTER TYPE "AuditActionType" ADD VALUE 'SPRUCE_VENDOR_MAPPED';
ALTER TYPE "AuditActionType" ADD VALUE 'SPRUCE_VENDOR_RETIRED';

-- AlterTable
ALTER TABLE "NegotiatedRate" ADD COLUMN     "spruceItemCode" TEXT,
ADD COLUMN     "supplierItemCode" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "NegotiatedRate_supplierId_effectiveFrom_idx" ON "NegotiatedRate"("supplierId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "NegotiatedRate_supplierId_spruceItemCode_idx" ON "NegotiatedRate"("supplierId", "spruceItemCode");
