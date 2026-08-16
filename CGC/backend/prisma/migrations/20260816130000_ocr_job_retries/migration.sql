-- Retry bookkeeping for OCR jobs.
--
-- The worker selected only `status = 'PENDING'`. Once a job was marked FAILED
-- nothing ever looked at it again, so one Textract timeout meant a ticket or
-- invoice sat unprocessed indefinitely and no screen reported it. These two
-- columns let the worker retry a bounded number of times with a delay between
-- attempts, and let the dashboard count what is genuinely stuck.
--
-- Additive and nullable/defaulted: existing rows get attempts = 0 and a NULL
-- nextAttemptAt, which the worker reads as "due now". The currently deployed
-- code ignores both columns, so this is safe to apply before its release.
--
-- Backfill note: existing FAILED jobs are deliberately NOT reset here. Retrying
-- every historical failure the moment this ships could stampede Textract and
-- re-bill for documents that were already handled by hand. Requeue them
-- deliberately, in batches, once someone has looked at why they failed:
--
--   UPDATE "public"."OcrJob"
--      SET "status" = 'PENDING', "attempts" = 0, "nextAttemptAt" = NULL
--    WHERE "status" = 'FAILED' AND "finishedAt" > now() - interval '7 days';
--
-- Rollback:
--   DROP INDEX IF EXISTS "public"."OcrJob_status_nextAttemptAt_idx";
--   ALTER TABLE "public"."OcrJob" DROP COLUMN IF EXISTS "nextAttemptAt";
--   ALTER TABLE "public"."OcrJob" DROP COLUMN IF EXISTS "attempts";

ALTER TABLE "public"."OcrJob"
  ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "public"."OcrJob"
  ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "OcrJob_status_nextAttemptAt_idx"
  ON "public"."OcrJob" ("status", "nextAttemptAt");
