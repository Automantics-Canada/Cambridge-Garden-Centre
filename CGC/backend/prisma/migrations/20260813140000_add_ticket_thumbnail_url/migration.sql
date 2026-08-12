-- Adds Ticket.thumbnailUrl for the small derived WebP used by the tickets list
-- and the driver mobile view.
--
-- Additive and nullable: existing rows keep working with a NULL value, and both
-- the UI and the API fall back to `imageUrl` when it is absent. Nothing is
-- rewritten, dropped, or backfilled by this migration — the backfill is a
-- separate, resumable CLI so it can be run and re-run under supervision.
--
-- Rollback: `ALTER TABLE "public"."Ticket" DROP COLUMN "thumbnailUrl";`
-- Dropping the column loses only the pointers, not the images. The thumbnail
-- objects remain in storage under ticket-thumbnails/ and would be recreated at
-- the same deterministic keys if the column is re-added and the backfill re-run.

ALTER TABLE "public"."Ticket" ADD COLUMN IF NOT EXISTS "thumbnailUrl" TEXT;
