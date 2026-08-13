-- Composite indexes for the list screens.
--
-- The tickets and invoices list screens filter on `status` and order by
-- `receivedAt DESC`. Only single-column indexes exist for those columns today,
-- and a single-column index does not support both halves of that shape. These
-- composite indexes do.
--
-- No query plan was captured for this change. GET /api/tickets was measured at
-- ~6s in production, but that figure covers the whole endpoint and the index
-- contribution to it is unquantified. Run EXPLAIN (ANALYZE, BUFFERS) on the
-- list and count queries before and after to establish the actual effect.
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
