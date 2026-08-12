-- Composite indexes for the list screens.
--
-- The tickets and invoices tables are filtered on `status` and ordered by
-- `receivedAt DESC`. Separate single-column indexes cannot serve both halves of
-- that query, so Postgres reads every matching row and sorts it on each page
-- load. Measured against production, GET /api/tickets took ~6s.
--
-- These are plain (non-CONCURRENT) index builds, which take a brief write lock
-- on the table. That is deliberate: these tables are small today (tens to low
-- thousands of rows) so the build is effectively instant, and Prisma runs
-- migrations inside a transaction, which CREATE INDEX CONCURRENTLY does not
-- permit. If these tables grow to the point where the lock matters, build the
-- index manually with CONCURRENTLY outside the migration runner instead.
--
-- IF NOT EXISTS keeps this safe to re-run.

CREATE INDEX IF NOT EXISTS "Ticket_status_receivedAt_idx"
  ON "public"."Ticket" ("status", "receivedAt" DESC);

CREATE INDEX IF NOT EXISTS "Ticket_supplierId_receivedAt_idx"
  ON "public"."Ticket" ("supplierId", "receivedAt" DESC);

CREATE INDEX IF NOT EXISTS "Invoice_status_receivedAt_idx"
  ON "public"."Invoice" ("status", "receivedAt" DESC);
