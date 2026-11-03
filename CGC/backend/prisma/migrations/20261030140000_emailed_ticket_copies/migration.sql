-- Emailed tickets counted once, and Excel files kept beside their invoice.
--
-- WHY
--
-- Some suppliers attach their delivery tickets to the invoice email (A15, under
-- half of them). Those tickets are now filed as tickets, but most tickets also
-- come from the drivers, so the same load usually arrives twice: the driver's
-- photo and the supplier's copy. Counted twice, the delivered quantity doubles
-- and hides an over-billed line, and a repeat invoice could be paid against the
-- second copy past the one-claim-per-ticket rule. "duplicateOfTicketId" links a
-- second copy to the copy that counts (the driver's when there is one); the
-- matching engine counts the load once and treats a claim on either copy as a
-- claim on the load. "emailSourceKey" names the email attachment page a ticket
-- was cut from, so a retried mailbox poll never files the same page twice.
--
-- A few suppliers send an Excel file next to the PDF invoice (A12). It is kept
-- as a supporting file of that invoice ("InvoiceSupportingFile") instead of
-- being read as a second invoice, which would bill the same loads twice.
--
-- SAFETY
--
-- Additive: two nullable columns on "Ticket" (no existing row changes; every
-- ticket starts as nobody's copy), a self-reference that sets itself to NULL
-- when the ticket it points at is deleted, a unique index that only non-null
-- keys take part in, and one new table hanging off "Invoice" with ON DELETE
-- CASCADE. The new table is read and written only by the API's server-side
-- connection; browser roles get no access, as every other table.
--
-- The OrderDocument / SupplierProductAlias "DROP DEFAULT" lines that
-- `prisma migrate diff` also prints are left out on purpose: those defaults
-- live in the database by design (20260907100000_reconcile_operational_schema).

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "duplicateOfTicketId" UUID,
ADD COLUMN     "emailSourceKey" TEXT;

-- CreateTable
CREATE TABLE "InvoiceSupportingFile" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "gmailKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceSupportingFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceSupportingFile_gmailKey_key" ON "InvoiceSupportingFile"("gmailKey");

-- CreateIndex
CREATE INDEX "InvoiceSupportingFile_invoiceId_idx" ON "InvoiceSupportingFile"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_emailSourceKey_key" ON "Ticket"("emailSourceKey");

-- CreateIndex
CREATE INDEX "Ticket_duplicateOfTicketId_idx" ON "Ticket"("duplicateOfTicketId");

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_duplicateOfTicketId_fkey" FOREIGN KEY ("duplicateOfTicketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceSupportingFile" ADD CONSTRAINT "InvoiceSupportingFile_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security: the browser roles never read this table directly.
ALTER TABLE public."InvoiceSupportingFile" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public."InvoiceSupportingFile" FROM anon, authenticated;
