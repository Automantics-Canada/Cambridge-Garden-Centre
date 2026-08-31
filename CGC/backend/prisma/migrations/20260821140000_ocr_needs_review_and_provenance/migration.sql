-- OCR review state and extraction provenance.
--
-- Backward-compatible only. New columns are nullable or carry a default, the
-- enum value is appended, and totalAmount is loosened from required to
-- optional. Existing invoice values are not rewritten.

-- A document that produced a usable candidate but needs a person. Previously
-- these were forced into either COMPLETED (which claimed the extraction was
-- trustworthy) or FAILED (which hid a perfectly readable document behind the
-- retry machinery).
ALTER TYPE "OcrJobStatus" ADD VALUE IF NOT EXISTS 'NEEDS_REVIEW' AFTER 'COMPLETED';

ALTER TABLE "OcrJob"
  ADD COLUMN IF NOT EXISTS "structuredProvider" TEXT,
  ADD COLUMN IF NOT EXISTS "structuredModel" TEXT,
  ADD COLUMN IF NOT EXISTS "fallbackUsed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "reviewReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "extractionConfidence" DOUBLE PRECISION;

-- The review desk's query: everything awaiting a person, newest first.
CREATE INDEX IF NOT EXISTS "OcrJob_status_finishedAt_idx" ON "OcrJob" ("status", "finishedAt");

-- A just-ingested invoice has no trustworthy total until extraction succeeds.
-- NULL preserves that distinction; zero is a valid business amount and must
-- never be used as an OCR placeholder.
ALTER TABLE "Invoice" ALTER COLUMN "totalAmount" DROP NOT NULL;
