-- Spruce line identity and vendor codes.
--
-- `Order.spruceItemNumber` carries the item code as printed on the report
-- line. The three Spruce reports print one document's lines in different
-- orders, so the previous positional identity (`documentId`, `lineNumber`)
-- overwrote different products onto an existing row on every cross-report
-- re-import. Reconciliation now pairs lines by item code; the line number is
-- display order only.
--
-- `SupplierSpruceVendor` maps the vendor codes Spruce prints (`BESTWAYS01`,
-- `UNILOCKL01`) to suppliers. The codes match no supplier's stored name, so
-- every vendor-bearing line imported with no supplier and invoice matching --
-- which needs both PO and supplier -- never fired.

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "spruceItemNumber" TEXT;

-- CreateTable
CREATE TABLE "SupplierSpruceVendor" (
    "code" TEXT NOT NULL,
    "supplierId" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierSpruceVendor_pkey" PRIMARY KEY ("code")
);

-- CreateForeignKey
ALTER TABLE "SupplierSpruceVendor" ADD CONSTRAINT "SupplierSpruceVendor_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "SupplierSpruceVendor_supplierId_idx" ON "SupplierSpruceVendor"("supplierId");

-- CreateIndex
CREATE INDEX "Order_spruceItemNumber_idx" ON "Order"("spruceItemNumber");

-- A job that finished with some rows imported and some refused is neither
-- COMPLETED nor FAILED; the UI needs to say so.
ALTER TYPE "ImportStatus" ADD VALUE 'PARTIAL';

-- An unknown buyer type must not block attaching legacy lines to their
-- document, and guessing CONTRACTOR hid the walk-in trade. Null now means
-- "nobody has established it", which is the honest value.
ALTER TABLE "OrderDocument"
  ALTER COLUMN "buyerType" DROP NOT NULL,
  ALTER COLUMN "buyerType" DROP DEFAULT;

-- Terminal replay must preserve the same summary the live SSE event carried.
-- The original job table had nowhere to store unchanged, absent, or conflict
-- counts, so a reconnect silently changed a partial result into a clean one.
ALTER TABLE "SpruceImportJob"
  ADD COLUMN "unchangedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "absentCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "conflictCount" INTEGER NOT NULL DEFAULT 0;

-- Prisma-created tables inherit Supabase's public-schema grants. Without RLS,
-- the anon key could read or write these rows through the Data API. The
-- application reaches the database through its server-side connection, so
-- browser roles intentionally receive no policies.
ALTER TABLE public."SupplierSpruceVendor" ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public."SupplierSpruceVendor" FROM anon, authenticated;
