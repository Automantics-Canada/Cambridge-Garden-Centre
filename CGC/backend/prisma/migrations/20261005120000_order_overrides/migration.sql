-- Lets a dispatcher correct an order without losing what Spruce says.
--
-- WHY
--
-- Spruce is often incomplete: no address, a project name in place of one, a
-- missing town. The dispatcher fills these in each morning, and a re-upload at
-- noon must not undo them. The corrected value is written into the order's own
-- column, so every screen and the driver's phone show it unchanged; each
-- OrderOverride row keeps Spruce's value beside it, so a later import that
-- brings a different value is recorded and flagged instead of winning.
--
-- SAFETY
--
-- Additive: two enum values, a nullable column and a new table. The table is
-- read and written only by the API's server-side connection; browser roles get
-- no access, as every other table.

ALTER TYPE "AuditActionType" ADD VALUE 'ORDER_EDITED';
ALTER TYPE "AuditActionType" ADD VALUE 'ORDER_EDIT_RESET';

-- AlterTable
ALTER TABLE "OrderDocument" ADD COLUMN     "dispatcherNotes" TEXT;

-- CreateTable
CREATE TABLE "OrderOverride" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "lineId" UUID,
    "targetKey" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "value" TEXT,
    "spruceValue" TEXT,
    "spruceValueAtEdit" TEXT,
    "spruceChanged" BOOLEAN NOT NULL DEFAULT false,
    "editedById" UUID NOT NULL,
    "editedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderOverride_documentId_idx" ON "OrderOverride"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderOverride_documentId_targetKey_field_key" ON "OrderOverride"("documentId", "targetKey", "field");

-- AddForeignKey
ALTER TABLE "OrderOverride" ADD CONSTRAINT "OrderOverride_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "OrderDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderOverride" ADD CONSTRAINT "OrderOverride_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderOverride" ADD CONSTRAINT "OrderOverride_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Lock down the new table: no policies for browser roles, as elsewhere.
ALTER TABLE public."OrderOverride" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public."OrderOverride" FROM anon, authenticated;
