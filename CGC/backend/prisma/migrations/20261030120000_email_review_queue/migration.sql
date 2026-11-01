-- Known email senders from supplier records, and a review queue for the rest.
--
-- WHY
--
-- The invoice inbox only accepted senders listed in a developer-only variable
-- (GMAIL_SENDER_ALLOWLIST). Anything else stayed in Gmail with one log line,
-- so a supplier nobody had listed only showed up as "their invoice never
-- arrived", and an Excel invoice was dropped without a word. The client cannot
-- export their safe-senders list (A11), and a few suppliers send Excel (A12).
--
-- Senders are now known from the supplier records: their email domains, a new
-- list of exact addresses (for suppliers on gmail.com and other shared mail
-- services, whose domain must never identify anyone) and the contact email.
-- Mail the app cannot attribute or read becomes a NEEDS_REVIEW row in the
-- existing mailbox log, shown on the Invoices page, where the office approves
-- the sender (and the email is read) or ignores it.
--
-- The observe-mode census wrote its note into "errorMessage", the only free
-- text column the log had. It moves to the new "note" column.
--
-- SAFETY
--
-- Additive: two enum values, nullable columns, two array columns defaulting to
-- empty, one index and one foreign key that sets itself to NULL when a user is
-- removed. The only data change copies census notes (rows whose errorMessage
-- starts with 'observe;', which only the observe mode writes) into "note" and
-- clears them from errorMessage; nothing is deleted. No new table, so no new
-- row-level-security setting is needed; both tables keep theirs.

-- AlterEnum
ALTER TYPE "EmailIngestionStatus" ADD VALUE 'NEEDS_REVIEW';
ALTER TYPE "EmailIngestionStatus" ADD VALUE 'IGNORED';

-- AlterTable
ALTER TABLE "EmailIngestionEvent" ADD COLUMN     "attachments" JSONB,
ADD COLUMN     "createdInvoiceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "forwardedBy" TEXT,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "originalFrom" TEXT,
ADD COLUMN     "requeuedAt" TIMESTAMP(3),
ADD COLUMN     "reviewReason" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" UUID,
ADD COLUMN     "senderMode" TEXT;

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "emailAddresses" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "EmailIngestionEvent_status_receivedAt_idx" ON "EmailIngestionEvent"("status", "receivedAt");

-- AddForeignKey
ALTER TABLE "EmailIngestionEvent" ADD CONSTRAINT "EmailIngestionEvent_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The census note moves to its own column.
UPDATE "EmailIngestionEvent"
SET "note" = "errorMessage", "errorMessage" = NULL
WHERE "errorMessage" LIKE 'observe;%';
