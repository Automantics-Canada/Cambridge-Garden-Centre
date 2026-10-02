-- Records each morning's three-report upload, and the order facts merged from it.
--
-- WHY
--
-- The yard runs three Spruce reports every morning and none is enough on its
-- own: the delivery report says what goes out today (with phone and route),
-- the order summary what it costs, the item tracking report where it goes and
-- what was bought from suppliers for it. Joined on the document number they
-- make one order record. This adds the columns that record holds, and two
-- tables that remember what each upload contained, so a day can be explained
-- and re-merged later without the PDFs.
--
-- SAFETY
--
-- Additive only. New columns are nullable or defaulted, so code that does not
-- know them is unaffected while the deploy rolls out. The two new tables are
-- read and written only by the API's server-side connection; browser roles get
-- no access, exactly as every other table in the schema.

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('PROCESSING', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "OrderDocument" ADD COLUMN     "accountCode" TEXT,
ADD COLUMN     "accountName" TEXT,
ADD COLUMN     "addressNormalized" TEXT,
ADD COLUMN     "cashier" TEXT,
ADD COLUMN     "deliveryFlag" TEXT,
ADD COLUMN     "deliveryInstructions" TEXT,
ADD COLUMN     "deliveryTruck" TEXT,
ADD COLUMN     "deliveryType" TEXT,
ADD COLUMN     "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "grossMarginPct" DECIMAL(7,2),
ADD COLUMN     "isPickup" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastBatchId" UUID,
ADD COLUMN     "orderNotes" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "remaining" DECIMAL(12,2),
ADD COLUMN     "remainingDeposit" DECIMAL(12,2),
ADD COLUMN     "route" TEXT,
ADD COLUMN     "sourceReports" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "spruceStatus" TEXT,
ADD COLUMN     "totalWithTax" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "lineClass" TEXT,
ADD COLUMN     "poValue" DECIMAL(12,2),
ADD COLUMN     "unitCost" DECIMAL(12,4),
ADD COLUMN     "unitPrice" DECIMAL(12,4),
ADD COLUMN     "vendorCode" TEXT,
ADD COLUMN     "vendorLocation" TEXT;

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" UUID NOT NULL,
    "dispatchDate" DATE NOT NULL,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'PROCESSING',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "summary" JSONB,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatchFile" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "reportType" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "pageCount" INTEGER NOT NULL,
    "reportDateFrom" DATE,
    "reportDateTo" DATE,
    "rowCount" INTEGER NOT NULL,
    "documentCount" INTEGER NOT NULL,
    "unreadableCount" INTEGER NOT NULL,
    "extraction" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportBatchFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportBatch_dispatchDate_idx" ON "ImportBatch"("dispatchDate");

-- CreateIndex
CREATE INDEX "ImportBatchFile_batchId_idx" ON "ImportBatchFile"("batchId");

-- CreateIndex
CREATE INDEX "ImportBatchFile_fileHash_idx" ON "ImportBatchFile"("fileHash");

-- CreateIndex
CREATE INDEX "OrderDocument_deliveryDate_idx" ON "OrderDocument"("deliveryDate");

-- AddForeignKey
ALTER TABLE "OrderDocument" ADD CONSTRAINT "OrderDocument_lastBatchId_fkey" FOREIGN KEY ("lastBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatchFile" ADD CONSTRAINT "ImportBatchFile_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Lock down the new tables: no policies for browser roles, as elsewhere.
ALTER TABLE public."ImportBatch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ImportBatchFile" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public."ImportBatch" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."ImportBatchFile" FROM anon, authenticated;
