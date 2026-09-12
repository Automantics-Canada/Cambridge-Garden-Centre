-- One delivery load can pay for exactly one invoice line.
--
-- WHY
--
-- The matching engine summed every ticket carrying an invoice line's PO and
-- never asked whether a ticket had already been used to pay something else. One
-- 24.6 tonne load billed on two lines returned MATCHED on both, with the
-- coverage check passing on each — a green light to pay the same delivery
-- twice, from the system whose entire purpose is to prevent that.
--
-- `TicketClaim.ticketId` is unique, and that constraint is the protection. It
-- also settles the race where two people confirm competing lines at the same
-- moment: both may pass their checks, only one insert survives.
--
-- WHAT MAKES A CLAIM
--
-- Only a person. A claim is written when somebody CONFIRMS or OVERRIDES an
-- invoice line — the moment money is committed — and deleted when that decision
-- is rejected or reopened, so a wrongly rejected duplicate cannot block the
-- real invoice forever.
--
-- NOT A DATA MIGRATION
--
-- Both objects are new and empty. The pre-existing implicit join
-- `_InvoiceLineItemToTicket` attaches every ticket with a PO to every line with
-- that PO; that is the over-counting itself, not a record of claims, so it is
-- deliberately NOT used to seed this table. Invoices already verified are a
-- separate question, for a reviewed backfill rather than a migration that picks
-- a winner on its own.

CREATE TABLE IF NOT EXISTS "TicketClaim" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "invoiceLineId" UUID NOT NULL,
    "matchResultId" UUID,
    "claimedById" UUID NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketClaim_pkey" PRIMARY KEY ("id")
);

-- The protection: one load, one claim.
CREATE UNIQUE INDEX IF NOT EXISTS "TicketClaim_ticketId_key" ON "TicketClaim"("ticketId");
CREATE INDEX IF NOT EXISTS "TicketClaim_invoiceLineId_idx" ON "TicketClaim"("invoiceLineId");

DO $$ BEGIN
  ALTER TABLE "TicketClaim" ADD CONSTRAINT "TicketClaim_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "TicketClaim" ADD CONSTRAINT "TicketClaim_invoiceLineId_fkey"
    FOREIGN KEY ("invoiceLineId") REFERENCES "InvoiceLineItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "TicketClaim" ADD CONSTRAINT "TicketClaim_claimedById_fkey"
    FOREIGN KEY ("claimedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- What a verdict actually counted, so a resolution claims those tickets rather
-- than whatever carries the PO at the moment somebody clicks Confirm. A load
-- photographed after the verdict was computed was never part of what was
-- approved.
ALTER TABLE "MatchResult" ADD COLUMN IF NOT EXISTS "ticketIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
