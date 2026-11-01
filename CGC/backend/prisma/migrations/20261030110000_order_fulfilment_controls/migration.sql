-- Lets dispatch say how an order reaches the customer, and where it is loaded.
--
-- WHY
--
-- The reports leave two things to the dispatcher (client answers of
-- 22/10/2026). An "FOB <supplier>" order is collected by the customer more
-- than 95% of the time, and a supplier's own truck delivers only rarely, so
-- the few exceptions need a person to say so: "fulfilmentOverride" holds one
-- of the five fulfilment types, or nothing for "as the reports say". And a
-- "PitBlk" order with no supplier PO names no pit: dispatch decides which one
-- each time, so "pickupSupplierId" names the supplier to load at and
-- "pickupLocation" which of its yards. Both are ours, like dispatcherNotes: no
-- report writes them, so a re-import never undoes them.
--
-- SAFETY
--
-- Additive: three nullable columns on OrderDocument, an index and a foreign
-- key. Existing rows read as "as the reports say" with no pit, which is
-- exactly how they behave today. Deleting a supplier clears the pit on its
-- orders (ON DELETE SET NULL) rather than blocking the delete or the order.
-- The CHECK keeps the override to the five known types even for a write that
-- bypasses the API. No new table, so no new RLS policy: OrderDocument keeps
-- the row-level security and revoked browser grants it already has.

-- AlterTable
ALTER TABLE "OrderDocument" ADD COLUMN     "fulfilmentOverride" TEXT,
ADD COLUMN     "pickupLocation" TEXT,
ADD COLUMN     "pickupSupplierId" UUID;

-- Only the five fulfilment types, or nothing.
ALTER TABLE "OrderDocument" ADD CONSTRAINT "OrderDocument_fulfilmentOverride_check" CHECK (
    "fulfilmentOverride" IS NULL OR "fulfilmentOverride" IN (
        'yard_pickup', 'yard_delivery', 'supplier_haul_delivery', 'external_pickup', 'supplier_direct_ship'
    )
);

-- CreateIndex
CREATE INDEX "OrderDocument_pickupSupplierId_idx" ON "OrderDocument"("pickupSupplierId");

-- AddForeignKey
ALTER TABLE "OrderDocument" ADD CONSTRAINT "OrderDocument_pickupSupplierId_fkey" FOREIGN KEY ("pickupSupplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
