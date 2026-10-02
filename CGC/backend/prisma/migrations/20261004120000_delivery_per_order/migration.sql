-- Dispatches whole Spruce orders instead of single item lines.
--
-- WHY
--
-- A driver delivers an order, not a line of it. The dispatch board made one
-- card per line, so an order of six items was six cards that could go to six
-- drivers. A stop now names the order it delivers, and one order has at most
-- one stop.
--
-- `orderId` stays and still points at a line (the order's first product line),
-- because tickets, matching and the driver's phone read a stop through it.
-- Stops created before this change have no order and are left as they are.
--
-- SAFETY
--
-- Additive: a nullable column, a unique index that ignores NULLs, and a
-- foreign key. Existing rows and the code that does not know the column are
-- unaffected while the deploy rolls out.

ALTER TABLE "Delivery" ADD COLUMN "documentId" UUID;

CREATE UNIQUE INDEX "Delivery_documentId_key" ON "Delivery"("documentId");

ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "OrderDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
