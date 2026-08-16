-- Supports the invoice verification fixes: a distinct flag for a unit clash,
-- and an exact supplier-wording-to-product mapping to replace fuzzy matching.
--
-- Both changes are additive. No existing row is rewritten and no existing value
-- becomes invalid, so the deployed application keeps working against this schema
-- before its own release lands.
--
-- 1. LineItemFlag gains UNIT_MISMATCH.
--
--    An agreed rate priced per tonne cannot be compared against a line invoiced
--    per short ton. That case previously fell through to a plain comparison and
--    reported a ten percent discrepancy that nobody had actually committed.
--    It is separated from RATE_UNKNOWN because the two are resolved differently:
--    RATE_UNKNOWN needs a rate adding, UNIT_MISMATCH needs a unit correcting.
--
--    ADD VALUE cannot run inside a transaction on PostgreSQL below 12, and
--    Prisma wraps migrations in one. Supabase runs 15, where this is permitted.
--    IF NOT EXISTS keeps it safe to re-run.
--
-- 2. SupplierProductAlias records a confirmed mapping.
--
--    Rates were matched to invoice lines by string similarity, where a 0.6
--    score or a substring hit counted as the same product — close enough that
--    "A Gravel" and "B Gravel" could be interchanged on a real payment. An
--    alias is entered once by a person and is exact from then on. Fuzzy
--    matching survives only as the fallback for wording nobody has mapped.
--
-- Rollback:
--   DROP TABLE IF EXISTS "public"."SupplierProductAlias";
--   -- Removing an enum value requires recreating the type. If UNIT_MISMATCH is
--   -- in use, first: UPDATE "public"."InvoiceLineItem"
--   --                SET "flag" = 'RATE_UNKNOWN' WHERE "flag" = 'UNIT_MISMATCH';
--   -- Leaving the unused value in place is harmless and is the safer option.

ALTER TYPE "public"."LineItemFlag" ADD VALUE IF NOT EXISTS 'UNIT_MISMATCH';

CREATE TABLE IF NOT EXISTS "public"."SupplierProductAlias" (
    "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
    "supplierId"  UUID         NOT NULL,
    "aliasText"   TEXT         NOT NULL,
    "productName" TEXT         NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SupplierProductAlias_pkey" PRIMARY KEY ("id")
);

-- One mapping per supplier per wording. The alias text is stored already
-- normalised (lower case, punctuation collapsed to single spaces) by the
-- application, so this uniqueness is on the normalised form.
CREATE UNIQUE INDEX IF NOT EXISTS "SupplierProductAlias_supplierId_aliasText_key"
  ON "public"."SupplierProductAlias" ("supplierId", "aliasText");

CREATE INDEX IF NOT EXISTS "SupplierProductAlias_supplierId_idx"
  ON "public"."SupplierProductAlias" ("supplierId");

DO $$
BEGIN
  ALTER TABLE "public"."SupplierProductAlias"
    ADD CONSTRAINT "SupplierProductAlias_supplierId_fkey"
    FOREIGN KEY ("supplierId") REFERENCES "public"."Supplier"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
