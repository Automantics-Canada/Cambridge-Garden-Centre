-- Records what Spruce changed on an order when its reports are uploaded again.
--
-- WHY
--
-- The yard may re-run the Spruce reports at noon. The re-upload refreshes each
-- order in place and never touches drivers or statuses, so without a record
-- the dispatcher cannot tell that an address or a quantity moved since the
-- morning. Each change the import makes to an existing order is one row here,
-- and the board marks those fields "Updated" for the rest of the day.
--
-- SAFETY
--
-- Additive: one new table, read and written only by the API's server-side
-- connection. It hangs off OrderDocument with ON DELETE CASCADE, so removing
-- or truncating orders removes their changes too. Browser roles get no access,
-- as every other table.

-- CreateTable
CREATE TABLE "OrderChange" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "lineId" UUID,
    "batchId" UUID,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderChange_documentId_createdAt_idx" ON "OrderChange"("documentId", "createdAt");

-- CreateIndex
CREATE INDEX "OrderChange_lineId_idx" ON "OrderChange"("lineId");

-- AddForeignKey
ALTER TABLE "OrderChange" ADD CONSTRAINT "OrderChange_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "OrderDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderChange" ADD CONSTRAINT "OrderChange_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Lock down the new table: no policies for browser roles, as elsewhere.
ALTER TABLE public."OrderChange" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public."OrderChange" FROM anon, authenticated;
