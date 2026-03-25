/*
  Warnings:

  - The primary key for the `User` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `password` on the `User` table. All the data in the column will be lost.
  - Added the required column `passwordHash` to the `User` table without a default value. This is not possible if the table is not empty.
  - Added the required column `role` to the `User` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `id` on the `User` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "BuyerType" AS ENUM ('RETAIL', 'CONTRACTOR');

-- CreateEnum
CREATE TYPE "TicketSource" AS ENUM ('WHATSAPP', 'EMAIL');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('UNLINKED', 'LINKED', 'REVIEWED');

-- CreateEnum
CREATE TYPE "SenderType" AS ENUM ('SUPPLIER', 'TRUCKING_COMPANY');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('PENDING_REVIEW', 'VERIFIED', 'DISPUTED', 'PAID');

-- CreateEnum
CREATE TYPE "LineItemFlag" AS ENUM ('OK', 'RATE_MISMATCH', 'QTY_MISMATCH', 'NO_TICKET', 'NO_ORDER', 'RATE_UNKNOWN', 'MULTIPLE_FLAGS');

-- CreateEnum
CREATE TYPE "SupplierType" AS ENUM ('SUPPLIER', 'TRUCKING_COMPANY');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('AP_USER', 'OWNER', 'ADMIN');

-- CreateEnum
CREATE TYPE "OcrTargetType" AS ENUM ('TICKET', 'INVOICE');

-- CreateEnum
CREATE TYPE "OcrProvider" AS ENUM ('GOOGLE_VISION', 'AWS_TEXTRACT');

-- CreateEnum
CREATE TYPE "OcrStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "AuditEntityType" AS ENUM ('INVOICE', 'TICKET', 'ORDER', 'SUPPLIER', 'RATE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AuditActionType" AS ENUM ('INVOICE_VERIFIED', 'INVOICE_DISPUTED', 'INVOICE_REOPENED', 'TICKET_LINKED', 'TICKET_REVIEWED', 'RATE_CREATED', 'RATE_UPDATED', 'EMAIL_INGESTION_ERROR', 'WHATSAPP_WEBHOOK_ERROR', 'OCR_RETRY', 'SYSTEM_CONFIG_CHANGE');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "EmailIngestionStatus" AS ENUM ('PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "SenderTypeResolved" AS ENUM ('SUPPLIER', 'TRUCKING_COMPANY', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "WhatsAppMessageType" AS ENUM ('IMAGE', 'TEXT', 'OTHER');

-- CreateEnum
CREATE TYPE "WhatsAppMessageStatus" AS ENUM ('PROCESSED', 'IGNORED', 'FAILED');

-- AlterTable
ALTER TABLE "User" DROP CONSTRAINT "User_pkey",
DROP COLUMN "password",
ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "passwordHash" TEXT NOT NULL,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "role" "UserRole" NOT NULL,
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
ADD CONSTRAINT "User_pkey" PRIMARY KEY ("id");

-- CreateTable
CREATE TABLE "Order" (
    "id" UUID NOT NULL,
    "spruceOrderId" TEXT NOT NULL,
    "poNumber" TEXT,
    "customerName" TEXT NOT NULL,
    "buyerType" "BuyerType" NOT NULL,
    "product" TEXT NOT NULL,
    "quantity" DECIMAL NOT NULL,
    "unit" TEXT NOT NULL,
    "supplierId" UUID,
    "orderDate" DATE NOT NULL,
    "deliveryDate" DATE,
    "hasInvoice" BOOLEAN NOT NULL DEFAULT false,
    "invoiceNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" UUID NOT NULL,
    "ticketNumber" TEXT,
    "source" "TicketSource" NOT NULL,
    "supplierId" UUID,
    "poNumber" TEXT,
    "material" TEXT,
    "quantity" DECIMAL,
    "unit" TEXT,
    "rateOnTicket" DECIMAL,
    "ticketDate" DATE,
    "imageUrl" TEXT NOT NULL,
    "ocrRawText" TEXT NOT NULL,
    "ocrConfidence" DOUBLE PRECISION NOT NULL,
    "linkedOrderId" UUID,
    "linkMethod" TEXT,
    "linkedById" UUID,
    "status" "TicketStatus" NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "driverId" UUID,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "senderType" "SenderType" NOT NULL,
    "supplierId" UUID NOT NULL,
    "invoiceDate" DATE NOT NULL,
    "dueDate" DATE,
    "totalAmount" DECIMAL NOT NULL,
    "currency" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "emailFrom" TEXT NOT NULL,
    "emailSubject" TEXT NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "verifiedById" UUID,
    "verifiedAt" TIMESTAMP(3),
    "disputeNote" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ocrStatus" "OcrStatus" NOT NULL DEFAULT 'PENDING',
    "ocrRawText" TEXT,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLineItem" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "poNumber" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL NOT NULL,
    "unit" TEXT NOT NULL,
    "unitRate" DECIMAL NOT NULL,
    "lineTotal" DECIMAL NOT NULL,
    "matchedTicketId" UUID,
    "matchedOrderId" UUID,
    "negotiatedRate" DECIMAL,
    "rateDiscrepancy" DECIMAL,
    "qtyDiscrepancy" DECIMAL,
    "flag" "LineItemFlag" NOT NULL,

    CONSTRAINT "InvoiceLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NegotiatedRate" (
    "id" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "productName" TEXT NOT NULL,
    "rate" DECIMAL NOT NULL,
    "unit" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "notes" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NegotiatedRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "SupplierType" NOT NULL,
    "emailDomains" TEXT[],
    "contactName" TEXT,
    "contactEmail" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Driver" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Driver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "entityType" "AuditEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "actionType" "AuditActionType" NOT NULL,
    "performedById" UUID,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpruceImportJob" (
    "id" UUID NOT NULL,
    "uploadedById" UUID NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" "ImportStatus" NOT NULL DEFAULT 'PENDING',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "errorSummary" TEXT,

    CONSTRAINT "SpruceImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpruceImportRowError" (
    "id" UUID NOT NULL,
    "importJobId" UUID NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "rawRowData" TEXT NOT NULL,
    "errorMessage" TEXT NOT NULL,

    CONSTRAINT "SpruceImportRowError_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OcrJob" (
    "id" UUID NOT NULL,
    "targetType" "OcrTargetType" NOT NULL,
    "provider" "OcrProvider" NOT NULL,
    "status" "OcrStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "rawResponse" JSONB,
    "ticketId" UUID,
    "invoiceId" UUID,

    CONSTRAINT "OcrJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailIngestionEvent" (
    "id" UUID NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "supplierId" UUID,
    "senderTypeResolved" "SenderTypeResolved",
    "createdInvoiceId" UUID,
    "createdTicketIds" TEXT[],
    "status" "EmailIngestionStatus" NOT NULL DEFAULT 'PROCESSED',
    "errorMessage" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailIngestionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppMessage" (
    "id" UUID NOT NULL,
    "driverId" UUID,
    "fromPhone" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "messageType" "WhatsAppMessageType" NOT NULL,
    "mediaUrl" TEXT,
    "rawPayload" JSONB NOT NULL,
    "status" "WhatsAppMessageStatus" NOT NULL DEFAULT 'PROCESSED',
    "errorMessage" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Order_spruceOrderId_key" ON "Order"("spruceOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_gmailMessageId_key" ON "Invoice"("gmailMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_phone_key" ON "Driver"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "EmailIngestionEvent_gmailMessageId_key" ON "EmailIngestionEvent"("gmailMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailIngestionEvent_createdInvoiceId_key" ON "EmailIngestionEvent"("createdInvoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "SystemSetting_key_key" ON "SystemSetting"("key");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_linkedOrderId_fkey" FOREIGN KEY ("linkedOrderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_linkedById_fkey" FOREIGN KEY ("linkedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLineItem" ADD CONSTRAINT "InvoiceLineItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLineItem" ADD CONSTRAINT "InvoiceLineItem_matchedTicketId_fkey" FOREIGN KEY ("matchedTicketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLineItem" ADD CONSTRAINT "InvoiceLineItem_matchedOrderId_fkey" FOREIGN KEY ("matchedOrderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NegotiatedRate" ADD CONSTRAINT "NegotiatedRate_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NegotiatedRate" ADD CONSTRAINT "NegotiatedRate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpruceImportJob" ADD CONSTRAINT "SpruceImportJob_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpruceImportRowError" ADD CONSTRAINT "SpruceImportRowError_importJobId_fkey" FOREIGN KEY ("importJobId") REFERENCES "SpruceImportJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OcrJob" ADD CONSTRAINT "OcrJob_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OcrJob" ADD CONSTRAINT "OcrJob_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailIngestionEvent" ADD CONSTRAINT "EmailIngestionEvent_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailIngestionEvent" ADD CONSTRAINT "EmailIngestionEvent_createdInvoiceId_fkey" FOREIGN KEY ("createdInvoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppMessage" ADD CONSTRAINT "WhatsAppMessage_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemSetting" ADD CONSTRAINT "SystemSetting_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
