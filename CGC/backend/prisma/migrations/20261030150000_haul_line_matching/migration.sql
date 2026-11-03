-- Lets a trucking invoice line be matched to the dispatch load it bills.
--
-- WHY
--
-- The client (22/10/2026, Q14): "The dispatcher sets the rate for each load
-- dispatched and it is matched up when the invoice comes in." Trucking
-- invoices list one line per load or per trip, with the day it was hauled and
-- a ticket or load number. Those two facts are what identify the load, so
-- each invoice line keeps them: "ticketNumber" as read, and "serviceDate".
--
-- A line's verdict also has to remember which loads it counted, so that a
-- person confirming it claims exactly those (DispatchLoad.claimedByLineItemId)
-- and not whatever fits at the moment they click. That is "MatchResult.loadIds",
-- the same arrangement as "MatchResult.ticketIds" for material lines. An array
-- on the verdict is the smallest shape that does it: the claim itself already
-- lives on DispatchLoad, and a join table would hold the same ids twice.
--
-- No index on "ticketNumber": the matcher looks loads up by the line's number,
-- never lines by a number, so an index would only cost writes.
--
-- SAFETY
--
-- Additive: two nullable columns and one array column with an empty default,
-- on existing tables. Existing rows keep their values and read as "no ticket
-- number, no service date, no loads". No new table, so no new grants; browser
-- roles keep no access, as before.
--
-- The three known `DROP DEFAULT` differences recorded in
-- 20260907100000_reconcile_operational_schema are left out on purpose.

-- AlterTable
ALTER TABLE "InvoiceLineItem" ADD COLUMN     "serviceDate" DATE,
ADD COLUMN     "ticketNumber" TEXT;

-- AlterTable
ALTER TABLE "MatchResult" ADD COLUMN     "loadIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
