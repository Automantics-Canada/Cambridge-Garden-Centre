-- Lets an order exist without an order date.
--
-- WHY
--
-- Spruce's delivery report prints one date per order, and the report is
-- filtered by delivery date: it is when the order goes out, not when it was
-- keyed. The importer read it as the order date, so every order keyed weeks
-- earlier was dated the day it was delivered, and none was given a delivery
-- date at all. The report does not print an entry date anywhere, so an order
-- first seen on it has no order date to give — and stamping one would be the
-- same lie the old importer told, which nothing downstream would catch.
--
-- The order summary and item tracking reports do print the entry date, and a
-- later import of either fills it in. Until then the column is null rather
-- than wrong.
--
-- SAFETY
--
-- Dropping NOT NULL only widens what the column accepts. Every existing row
-- keeps its value, and code that still writes a date is unaffected.

ALTER TABLE public."OrderDocument"
  ALTER COLUMN "orderDate" DROP NOT NULL;

ALTER TABLE public."Order"
  ALTER COLUMN "orderDate" DROP NOT NULL;
