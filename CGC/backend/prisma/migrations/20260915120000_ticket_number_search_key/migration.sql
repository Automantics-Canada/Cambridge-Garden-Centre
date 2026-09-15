-- Lets a ticket be found by its number however the number is typed.
--
-- WHY
--
-- Ticket search compared the typed text with the stored text exactly, apart from
-- case. People type a number the way the paper prints it; the extraction stores
-- it the way it read it; the two rarely agree on spaces, dashes and hash signs.
-- "T88213" found nothing when the ticket was stored as "T-88213", nor did
-- "#7387" for "7387" or "HBY-10512" for "HBY 10512". To the person searching,
-- a ticket that is on the list does not exist.
--
-- WHAT THIS STORES
--
-- The ticket number and the PO number reduced to their letters and digits and
-- lower-cased, joined by `|` so a match cannot run from one into the other.
-- `numberSearchKey` in src/modules/tickets/ticket.service.ts reduces the search
-- term by the same rule; the two must change together.
--
-- WHY A TRIGGER KEEPS IT
--
-- Tickets are created and edited on many paths — manual upload, PDF split,
-- WhatsApp, email, extraction, the review form. A key the application maintained
-- would go stale the first time one of them forgot to refresh it, and that
-- ticket would quietly stop being findable. The trigger recomputes it on every
-- write, overwriting whatever a write supplied, so it cannot drift.
--
-- A GENERATED column would say the same thing more directly, but Prisma reads
-- its expression as a column default and plans `DROP DEFAULT` against it, which
-- Postgres refuses on a generated column. Every later `prisma migrate dev` would
-- produce a migration that fails. Prisma does not see triggers, so this form
-- stays out of its way.

ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "numberSearchKey" TEXT;

CREATE OR REPLACE FUNCTION public.ticket_number_search_key()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW."numberSearchKey" :=
    pg_catalog.lower(pg_catalog.regexp_replace(COALESCE(NEW."ticketNumber", ''), '[^A-Za-z0-9]+', '', 'g'))
    || '|'
    || pg_catalog.lower(pg_catalog.regexp_replace(COALESCE(NEW."poNumber", ''), '[^A-Za-z0-9]+', '', 'g'));
  RETURN NEW;
END;
$$;

-- Only ever called by the trigger below. Supabase grants new public functions to
-- its browser roles; nothing outside the database has a reason to call this.
REVOKE ALL ON FUNCTION public.ticket_number_search_key() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS "Ticket_numberSearchKey" ON "Ticket";
CREATE TRIGGER "Ticket_numberSearchKey"
  BEFORE INSERT OR UPDATE ON "Ticket"
  FOR EACH ROW EXECUTE FUNCTION public.ticket_number_search_key();

-- Existing tickets. The value written here is discarded: the trigger computes
-- the real key for each row as it is updated.
UPDATE "Ticket" SET "numberSearchKey" = NULL;
