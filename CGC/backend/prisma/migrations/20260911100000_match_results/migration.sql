-- A stored verdict on whether a document is backed by what CGC ordered and received.
--
-- WHY
--
-- Until now the system could not answer its own central question — should we
-- pay this? — except by a person reading two documents side by side. A nightly
-- job once claimed to answer it and was removed in #21 because it hard-coded
-- the answer. This table is the honest version: every verdict is stored
-- alongside `evidence`, the list of checks that ran, what each compared and
-- what it found. A status is never written without the reasoning behind it.
--
-- SHAPE
--
-- One row per subject, enforced by the two unique indexes: a ticket or an
-- invoice line has exactly one current verdict. Recomputing replaces it.
--
-- `resolution` is how a person's decision is kept. A resolved row is theirs and
-- a recompute must leave it alone; that rule lives in matching.service.ts,
-- because it is a policy rather than something a constraint can express.
--
-- `candidateOrderIds` carries the orders still in play when the status is
-- CONFLICT, so the desk can offer the choice instead of making it.
--
-- Additive and guarded, so it is safe on a database that already has these
-- objects and on one built only from this migration chain.
--
-- NOT INCLUDED ON PURPOSE
--
-- `prisma migrate diff` also proposes dropping the database-side defaults on
-- OrderDocument.id, OrderDocument.updatedAt and SupplierProductAlias.id. That
-- is the pre-existing cosmetic drift documented in
-- 20260907100000_reconcile_operational_schema; production and a fresh build
-- already agree with each other, and dropping those defaults would remove a
-- safety net for no benefit. It stays out of a migration about matching.

DO $$ BEGIN
  CREATE TYPE "MatchSubjectType" AS ENUM ('TICKET', 'INVOICE_LINE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "MatchStatus" AS ENUM ('MATCHED', 'PARTIAL', 'UNMATCHED', 'CONFLICT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "MatchResolution" AS ENUM ('CONFIRMED', 'OVERRIDDEN', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "MatchResult" (
    "id" UUID NOT NULL,
    "subjectType" "MatchSubjectType" NOT NULL,
    "ticketId" UUID,
    "invoiceLineId" UUID,
    "orderId" UUID,
    "status" "MatchStatus" NOT NULL,
    "evidence" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "candidateOrderIds" TEXT[],
    "engineVersion" INTEGER NOT NULL DEFAULT 1,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMP(3),
    "resolution" "MatchResolution",
    "resolutionNote" TEXT,

    CONSTRAINT "MatchResult_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MatchResult_status_idx" ON "MatchResult"("status");
CREATE INDEX IF NOT EXISTS "MatchResult_orderId_idx" ON "MatchResult"("orderId");
-- The desk's query: everything at one status, newest first.
CREATE INDEX IF NOT EXISTS "MatchResult_status_computedAt_idx" ON "MatchResult"("status", "computedAt");

-- One current verdict per subject.
CREATE UNIQUE INDEX IF NOT EXISTS "MatchResult_ticketId_key" ON "MatchResult"("ticketId");
CREATE UNIQUE INDEX IF NOT EXISTS "MatchResult_invoiceLineId_key" ON "MatchResult"("invoiceLineId");

-- Deleting a ticket or an invoice line takes its verdict with it: a verdict
-- about a document that no longer exists is not evidence of anything. Deleting
-- an order or a user only clears the reference, because the verdict and the
-- reasoning behind it are still a true record of what was decided.
DO $$ BEGIN
  ALTER TABLE "MatchResult" ADD CONSTRAINT "MatchResult_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "MatchResult" ADD CONSTRAINT "MatchResult_invoiceLineId_fkey"
    FOREIGN KEY ("invoiceLineId") REFERENCES "InvoiceLineItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "MatchResult" ADD CONSTRAINT "MatchResult_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "MatchResult" ADD CONSTRAINT "MatchResult_resolvedById_fkey"
    FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
