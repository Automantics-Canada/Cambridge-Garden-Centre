-- Gives a Spruce order a real, stable identity: its document number.
--
-- WHY
--
-- `Order` is one line item, keyed by `spruceOrderId`, which the importer
-- synthesises from the row's position in the uploaded PDF — `123456-P2-T2-4`
-- means document 123456, page 2, table 2, row 4. Two problems follow:
--
--   1. The delivery report and the PO report cannot be joined. The join key is
--      the document number, and no column holds it as a key.
--   2. Re-importing a regenerated report duplicates orders. Insert one row near
--      the top in Spruce and every row below it shifts to a new position, hence
--      a new key, hence a new Order for work that already existed.
--
-- SHAPE
--
-- Additive on purpose. `Order` keeps its id and its `spruceOrderId`, so every
-- existing foreign key — Delivery.orderId, Ticket.linkedOrderId,
-- TicketOrderMatch.orderId, InvoiceLineItem.matchedOrderId — still resolves and
-- no running query changes meaning. Restructuring `Order` itself would have
-- touched all four plus every screen; this does not.
--
-- `documentId` and `lineNumber` are nullable so this migration can be applied
-- before the backfill runs, and so rows created by the legacy path stay valid.
-- Tighten to NOT NULL in a later migration once the backfill has completed and
-- the importer has been writing them for a full reporting cycle.
--
-- BACKFILL
--
-- Not done here. `scripts/backfillOrderDocuments.ts` derives the document
-- number from the existing `spruceOrderId`, runs read-only by default, and
-- reports what it would create before `--apply` writes anything. Running it
-- inside this migration would mean a large unsupervised write during deploy.
--
-- Rollback:
--   ALTER TABLE "public"."Order" DROP CONSTRAINT IF EXISTS "Order_documentId_fkey";
--   DROP INDEX IF EXISTS "public"."Order_documentId_lineNumber_key";
--   DROP INDEX IF EXISTS "public"."Order_documentId_idx";
--   ALTER TABLE "public"."Order" DROP COLUMN IF EXISTS "lineNumber";
--   ALTER TABLE "public"."Order" DROP COLUMN IF EXISTS "documentId";
--   DROP TABLE IF EXISTS "public"."OrderDocument";
-- Nothing depends on these columns until the importer starts writing them, so
-- rollback loses only the grouping, not any order data.

CREATE TABLE IF NOT EXISTS "public"."OrderDocument" (
    "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
    "documentNumber"  TEXT         NOT NULL,
    "customerName"    TEXT         NOT NULL,
    "poNumber"        TEXT,
    "buyerType"       "public"."BuyerType" NOT NULL DEFAULT 'CONTRACTOR',
    "orderDate"       DATE         NOT NULL,
    "deliveryDate"    DATE,
    "shippingAddress" TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderDocument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OrderDocument_documentNumber_key"
  ON "public"."OrderDocument" ("documentNumber");

CREATE INDEX IF NOT EXISTS "OrderDocument_orderDate_idx"
  ON "public"."OrderDocument" ("orderDate");

CREATE INDEX IF NOT EXISTS "OrderDocument_poNumber_idx"
  ON "public"."OrderDocument" ("poNumber");

ALTER TABLE "public"."Order" ADD COLUMN IF NOT EXISTS "documentId" UUID;
ALTER TABLE "public"."Order" ADD COLUMN IF NOT EXISTS "lineNumber" INTEGER;

-- Plain, not partial, so it matches exactly what Prisma generates from
-- `@@unique([documentId, lineNumber])` and the schema does not drift. Postgres
-- treats NULLs as distinct in a unique index, so the un-backfilled tail of rows
-- with (NULL, NULL) does not collide.
CREATE UNIQUE INDEX IF NOT EXISTS "Order_documentId_lineNumber_key"
  ON "public"."Order" ("documentId", "lineNumber");

CREATE INDEX IF NOT EXISTS "Order_documentId_idx"
  ON "public"."Order" ("documentId");

DO $$
BEGIN
  ALTER TABLE "public"."Order"
    ADD CONSTRAINT "Order_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "public"."OrderDocument"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
