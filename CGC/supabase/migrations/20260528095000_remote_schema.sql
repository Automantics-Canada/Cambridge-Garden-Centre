


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;




ALTER SCHEMA "public" OWNER TO "postgres";


CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE TYPE "public"."AuditActionType" AS ENUM (
    'INVOICE_VERIFIED',
    'INVOICE_DISPUTED',
    'INVOICE_REOPENED',
    'TICKET_LINKED',
    'TICKET_REVIEWED',
    'RATE_CREATED',
    'RATE_UPDATED',
    'EMAIL_INGESTION_ERROR',
    'WHATSAPP_WEBHOOK_ERROR',
    'OCR_RETRY',
    'SYSTEM_CONFIG_CHANGE',
    'INVOICE_LINE_OVERRIDDEN'
);


ALTER TYPE "public"."AuditActionType" OWNER TO "postgres";


CREATE TYPE "public"."AuditEntityType" AS ENUM (
    'INVOICE',
    'TICKET',
    'ORDER',
    'SUPPLIER',
    'RATE',
    'SYSTEM'
);


ALTER TYPE "public"."AuditEntityType" OWNER TO "postgres";


CREATE TYPE "public"."BuyerType" AS ENUM (
    'RETAIL',
    'CONTRACTOR'
);


ALTER TYPE "public"."BuyerType" OWNER TO "postgres";


CREATE TYPE "public"."DeliveryStatus" AS ENUM (
    'UNASSIGNED',
    'PLACED',
    'OUT_FOR_DELIVERY',
    'IN_TRANSIT',
    'DELIVERED',
    'ON_HOLD',
    'DELAYED',
    'CANCELLED'
);


ALTER TYPE "public"."DeliveryStatus" OWNER TO "postgres";


CREATE TYPE "public"."DriverTaskStatus" AS ENUM (
    'NOT_STARTED',
    'AT_SUPPLIER',
    'IN_TRANSIT',
    'COMPLETED'
);


ALTER TYPE "public"."DriverTaskStatus" OWNER TO "postgres";


CREATE TYPE "public"."DriverType" AS ENUM (
    'CGC_FLEET',
    'INDEPENDENT'
);


ALTER TYPE "public"."DriverType" OWNER TO "postgres";


CREATE TYPE "public"."EmailIngestionStatus" AS ENUM (
    'PROCESSED',
    'FAILED'
);


ALTER TYPE "public"."EmailIngestionStatus" OWNER TO "postgres";


CREATE TYPE "public"."ImportStatus" AS ENUM (
    'PENDING',
    'PROCESSING',
    'COMPLETED',
    'FAILED'
);


ALTER TYPE "public"."ImportStatus" OWNER TO "postgres";


CREATE TYPE "public"."InvoiceStatus" AS ENUM (
    'PENDING_REVIEW',
    'VERIFIED',
    'DISPUTED',
    'PAID'
);


ALTER TYPE "public"."InvoiceStatus" OWNER TO "postgres";


CREATE TYPE "public"."LineItemFlag" AS ENUM (
    'OK',
    'RATE_MISMATCH',
    'QTY_MISMATCH',
    'NO_TICKET',
    'NO_ORDER',
    'RATE_UNKNOWN',
    'MULTIPLE_FLAGS'
);


ALTER TYPE "public"."LineItemFlag" OWNER TO "postgres";


CREATE TYPE "public"."LinkMethod" AS ENUM (
    'AUTO',
    'MANUAL'
);


ALTER TYPE "public"."LinkMethod" OWNER TO "postgres";


CREATE TYPE "public"."OcrJobStatus" AS ENUM (
    'PENDING',
    'PROCESSING',
    'COMPLETED',
    'FAILED'
);


ALTER TYPE "public"."OcrJobStatus" OWNER TO "postgres";


CREATE TYPE "public"."OcrJobType" AS ENUM (
    'TICKET',
    'INVOICE'
);


ALTER TYPE "public"."OcrJobType" OWNER TO "postgres";


CREATE TYPE "public"."OcrProvider" AS ENUM (
    'GOOGLE_VISION',
    'AWS_TEXTRACT'
);


ALTER TYPE "public"."OcrProvider" OWNER TO "postgres";


CREATE TYPE "public"."SenderType" AS ENUM (
    'SUPPLIER',
    'TRUCKING_COMPANY'
);


ALTER TYPE "public"."SenderType" OWNER TO "postgres";


CREATE TYPE "public"."SenderTypeResolved" AS ENUM (
    'SUPPLIER',
    'TRUCKING_COMPANY',
    'UNKNOWN'
);


ALTER TYPE "public"."SenderTypeResolved" OWNER TO "postgres";


CREATE TYPE "public"."SupplierType" AS ENUM (
    'SUPPLIER',
    'TRUCKING_COMPANY'
);


ALTER TYPE "public"."SupplierType" OWNER TO "postgres";


CREATE TYPE "public"."TicketSource" AS ENUM (
    'WHATSAPP',
    'EMAIL',
    'MANUAL'
);


ALTER TYPE "public"."TicketSource" OWNER TO "postgres";


CREATE TYPE "public"."TicketStatus" AS ENUM (
    'UNLINKED',
    'LINKED',
    'REVIEWED'
);


ALTER TYPE "public"."TicketStatus" OWNER TO "postgres";


CREATE TYPE "public"."UserRole" AS ENUM (
    'AP_USER',
    'OWNER',
    'ADMIN',
    'DRIVER'
);


ALTER TYPE "public"."UserRole" OWNER TO "postgres";


CREATE TYPE "public"."WhatsAppMessageStatus" AS ENUM (
    'PROCESSED',
    'IGNORED',
    'FAILED'
);


ALTER TYPE "public"."WhatsAppMessageStatus" OWNER TO "postgres";


CREATE TYPE "public"."WhatsAppMessageType" AS ENUM (
    'IMAGE',
    'TEXT',
    'OTHER'
);


ALTER TYPE "public"."WhatsAppMessageType" OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."AuditLog" (
    "id" "uuid" NOT NULL,
    "entityType" "public"."AuditEntityType" NOT NULL,
    "entityId" "text" NOT NULL,
    "actionType" "public"."AuditActionType" NOT NULL,
    "performedById" "uuid",
    "details" "jsonb",
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE "public"."AuditLog" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."Delivery" (
    "id" "uuid" NOT NULL,
    "orderId" "uuid" NOT NULL,
    "driverId" "uuid",
    "status" "public"."DeliveryStatus" DEFAULT 'UNASSIGNED'::"public"."DeliveryStatus" NOT NULL,
    "priority" integer DEFAULT 1 NOT NULL,
    "pickupType" "text" DEFAULT 'EXTERNAL'::"text" NOT NULL,
    "pickupPhotoUrl" "text",
    "deliveryPhotoUrl" "text",
    "startedAt" timestamp(3) without time zone,
    "completedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE "public"."Delivery" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."DeliveryHistory" (
    "id" "uuid" NOT NULL,
    "deliveryId" "uuid" NOT NULL,
    "status" "public"."DeliveryStatus" NOT NULL,
    "notes" "text",
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE "public"."DeliveryHistory" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."Driver" (
    "id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "phone" "text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "email" "text",
    "ratePerDelivery" numeric DEFAULT 0 NOT NULL,
    "ratePerTrip" numeric,
    "type" "public"."DriverType" DEFAULT 'CGC_FLEET'::"public"."DriverType" NOT NULL,
    "userId" "uuid",
    "companyName" "text"
);


ALTER TABLE "public"."Driver" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."EmailIngestionEvent" (
    "id" "uuid" NOT NULL,
    "gmailMessageId" "text" NOT NULL,
    "subject" "text" NOT NULL,
    "fromAddress" "text" NOT NULL,
    "toAddress" "text" NOT NULL,
    "supplierId" "uuid",
    "senderTypeResolved" "public"."SenderTypeResolved",
    "createdInvoiceId" "uuid",
    "createdTicketIds" "text"[],
    "status" "public"."EmailIngestionStatus" DEFAULT 'PROCESSED'::"public"."EmailIngestionStatus" NOT NULL,
    "errorMessage" "text",
    "receivedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE "public"."EmailIngestionEvent" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."Invoice" (
    "id" "uuid" NOT NULL,
    "invoiceNumber" "text" NOT NULL,
    "senderType" "public"."SenderType" NOT NULL,
    "supplierId" "uuid" NOT NULL,
    "invoiceDate" "date" NOT NULL,
    "dueDate" "date",
    "totalAmount" numeric NOT NULL,
    "currency" "text" NOT NULL,
    "fileUrl" "text" NOT NULL,
    "emailFrom" "text" NOT NULL,
    "emailSubject" "text" NOT NULL,
    "gmailMessageId" "text" NOT NULL,
    "status" "public"."InvoiceStatus" DEFAULT 'PENDING_REVIEW'::"public"."InvoiceStatus" NOT NULL,
    "verifiedById" "uuid",
    "verifiedAt" timestamp(3) without time zone,
    "disputeNote" "text",
    "receivedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "ocrRawText" "text",
    "OcrJobStatus" "public"."OcrJobStatus" DEFAULT 'PENDING'::"public"."OcrJobStatus" NOT NULL
);


ALTER TABLE "public"."Invoice" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."InvoiceLineItem" (
    "id" "uuid" NOT NULL,
    "invoiceId" "uuid" NOT NULL,
    "lineNumber" integer NOT NULL,
    "poNumber" "text",
    "description" "text" NOT NULL,
    "quantity" numeric NOT NULL,
    "unit" "text" NOT NULL,
    "unitRate" numeric NOT NULL,
    "lineTotal" numeric NOT NULL,
    "matchedOrderId" "uuid",
    "negotiatedRate" numeric,
    "rateDiscrepancy" numeric,
    "qtyDiscrepancy" numeric,
    "flag" "public"."LineItemFlag" NOT NULL,
    "isOverridden" boolean DEFAULT false NOT NULL,
    "overrideNote" "text",
    "approvedTotal" numeric
);


ALTER TABLE "public"."InvoiceLineItem" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."NegotiatedRate" (
    "id" "uuid" NOT NULL,
    "supplierId" "uuid" NOT NULL,
    "productName" "text" NOT NULL,
    "rate" numeric NOT NULL,
    "unit" "text" NOT NULL,
    "effectiveFrom" "date" NOT NULL,
    "effectiveTo" "date",
    "notes" "text",
    "createdById" "uuid" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE "public"."NegotiatedRate" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."OcrJob" (
    "id" "uuid" NOT NULL,
    "provider" "public"."OcrProvider" NOT NULL,
    "startedAt" timestamp(3) without time zone,
    "finishedAt" timestamp(3) without time zone,
    "errorMessage" "text",
    "rawResponse" "jsonb",
    "ticketId" "uuid",
    "invoiceId" "uuid",
    "type" "public"."OcrJobType" NOT NULL,
    "status" "public"."OcrJobStatus" DEFAULT 'PENDING'::"public"."OcrJobStatus" NOT NULL
);


ALTER TABLE "public"."OcrJob" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."Order" (
    "id" "uuid" NOT NULL,
    "spruceOrderId" "text" NOT NULL,
    "poNumber" "text",
    "customerName" "text" NOT NULL,
    "buyerType" "public"."BuyerType" NOT NULL,
    "product" "text" NOT NULL,
    "quantity" numeric NOT NULL,
    "unit" "text" NOT NULL,
    "supplierId" "uuid",
    "orderDate" "date" NOT NULL,
    "deliveryDate" "date",
    "hasInvoice" boolean DEFAULT false NOT NULL,
    "invoiceNumber" "text",
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "deliveryStatus" "public"."DriverTaskStatus" DEFAULT 'NOT_STARTED'::"public"."DriverTaskStatus" NOT NULL,
    "driverId" "uuid",
    "priority" integer DEFAULT 1 NOT NULL
);


ALTER TABLE "public"."Order" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."Product" (
    "id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "unit" "text" DEFAULT 'ton'::"text" NOT NULL
);


ALTER TABLE "public"."Product" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."SpruceImportJob" (
    "id" "uuid" NOT NULL,
    "uploadedById" "uuid" NOT NULL,
    "fileUrl" "text" NOT NULL,
    "startedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "finishedAt" timestamp(3) without time zone,
    "status" "public"."ImportStatus" DEFAULT 'PENDING'::"public"."ImportStatus" NOT NULL,
    "totalRows" integer DEFAULT 0 NOT NULL,
    "createdCount" integer DEFAULT 0 NOT NULL,
    "updatedCount" integer DEFAULT 0 NOT NULL,
    "skippedCount" integer DEFAULT 0 NOT NULL,
    "errorSummary" "text"
);


ALTER TABLE "public"."SpruceImportJob" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."SpruceImportRowError" (
    "id" "uuid" NOT NULL,
    "importJobId" "uuid" NOT NULL,
    "rowNumber" integer NOT NULL,
    "rawRowData" "text" NOT NULL,
    "errorMessage" "text" NOT NULL
);


ALTER TABLE "public"."SpruceImportRowError" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."Supplier" (
    "id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "type" "public"."SupplierType" NOT NULL,
    "emailDomains" "text"[],
    "contactName" "text",
    "contactEmail" "text",
    "phone" "text",
    "address" "text",
    "active" boolean DEFAULT true NOT NULL,
    "keywords" "text"[]
);


ALTER TABLE "public"."Supplier" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."SystemSetting" (
    "id" "uuid" NOT NULL,
    "key" "text" NOT NULL,
    "value" "jsonb" NOT NULL,
    "updatedById" "uuid",
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE "public"."SystemSetting" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."Ticket" (
    "id" "uuid" NOT NULL,
    "ticketNumber" "text",
    "source" "public"."TicketSource" NOT NULL,
    "supplierId" "uuid",
    "poNumber" "text",
    "material" "text",
    "quantity" numeric,
    "unit" "text",
    "rateOnTicket" numeric,
    "ticketDate" "date",
    "imageUrl" "text" NOT NULL,
    "ocrRawText" "text" NOT NULL,
    "ocrConfidence" double precision NOT NULL,
    "linkedOrderId" "uuid",
    "linkMethod" "text",
    "linkedById" "uuid",
    "status" "public"."TicketStatus" NOT NULL,
    "receivedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "driverId" "uuid",
    "deliveryStatus" "public"."DriverTaskStatus" DEFAULT 'NOT_STARTED'::"public"."DriverTaskStatus" NOT NULL,
    "spruceMatched" boolean DEFAULT false NOT NULL,
    "supplierName" "text"
);


ALTER TABLE "public"."Ticket" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."TicketOrderMatch" (
    "id" "uuid" NOT NULL,
    "ticketId" "uuid" NOT NULL,
    "orderId" "uuid" NOT NULL,
    "matchMethod" "text" NOT NULL,
    "matchedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "createdBy" "uuid"
);


ALTER TABLE "public"."TicketOrderMatch" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."Unit" (
    "id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE "public"."Unit" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."User" (
    "name" "text" NOT NULL,
    "email" "text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "passwordHash" "text" NOT NULL,
    "phone" "text",
    "role" "public"."UserRole" NOT NULL,
    "id" "uuid" NOT NULL
);


ALTER TABLE "public"."User" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."WhatsAppMessage" (
    "id" "uuid" NOT NULL,
    "driverId" "uuid",
    "fromPhone" "text" NOT NULL,
    "messageId" "text" NOT NULL,
    "messageType" "public"."WhatsAppMessageType" NOT NULL,
    "mediaUrl" "text",
    "rawPayload" "jsonb" NOT NULL,
    "status" "public"."WhatsAppMessageStatus" DEFAULT 'PROCESSED'::"public"."WhatsAppMessageStatus" NOT NULL,
    "errorMessage" "text",
    "receivedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE "public"."WhatsAppMessage" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."_InvoiceLineItemToTicket" (
    "A" "uuid" NOT NULL,
    "B" "uuid" NOT NULL
);


ALTER TABLE "public"."_InvoiceLineItemToTicket" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."_prisma_migrations" (
    "id" character varying(36) NOT NULL,
    "checksum" character varying(64) NOT NULL,
    "finished_at" timestamp with time zone,
    "migration_name" character varying(255) NOT NULL,
    "logs" "text",
    "rolled_back_at" timestamp with time zone,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "applied_steps_count" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."_prisma_migrations" OWNER TO "postgres";


ALTER TABLE ONLY "public"."AuditLog"
    ADD CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."DeliveryHistory"
    ADD CONSTRAINT "DeliveryHistory_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."Delivery"
    ADD CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."Driver"
    ADD CONSTRAINT "Driver_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."EmailIngestionEvent"
    ADD CONSTRAINT "EmailIngestionEvent_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."InvoiceLineItem"
    ADD CONSTRAINT "InvoiceLineItem_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."Invoice"
    ADD CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."NegotiatedRate"
    ADD CONSTRAINT "NegotiatedRate_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."OcrJob"
    ADD CONSTRAINT "OcrJob_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."Order"
    ADD CONSTRAINT "Order_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."Product"
    ADD CONSTRAINT "Product_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."SpruceImportJob"
    ADD CONSTRAINT "SpruceImportJob_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."SpruceImportRowError"
    ADD CONSTRAINT "SpruceImportRowError_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."Supplier"
    ADD CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."SystemSetting"
    ADD CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."TicketOrderMatch"
    ADD CONSTRAINT "TicketOrderMatch_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."Ticket"
    ADD CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."Unit"
    ADD CONSTRAINT "Unit_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."User"
    ADD CONSTRAINT "User_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."WhatsAppMessage"
    ADD CONSTRAINT "WhatsAppMessage_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."_InvoiceLineItemToTicket"
    ADD CONSTRAINT "_InvoiceLineItemToTicket_AB_pkey" PRIMARY KEY ("A", "B");



ALTER TABLE ONLY "public"."_prisma_migrations"
    ADD CONSTRAINT "_prisma_migrations_pkey" PRIMARY KEY ("id");



CREATE UNIQUE INDEX "Driver_email_key" ON "public"."Driver" USING "btree" ("email");



CREATE UNIQUE INDEX "Driver_phone_key" ON "public"."Driver" USING "btree" ("phone");



CREATE UNIQUE INDEX "Driver_userId_key" ON "public"."Driver" USING "btree" ("userId");



CREATE UNIQUE INDEX "EmailIngestionEvent_createdInvoiceId_key" ON "public"."EmailIngestionEvent" USING "btree" ("createdInvoiceId");



CREATE UNIQUE INDEX "EmailIngestionEvent_gmailMessageId_key" ON "public"."EmailIngestionEvent" USING "btree" ("gmailMessageId");



CREATE INDEX "InvoiceLineItem_invoiceId_idx" ON "public"."InvoiceLineItem" USING "btree" ("invoiceId");



CREATE INDEX "InvoiceLineItem_poNumber_idx" ON "public"."InvoiceLineItem" USING "btree" ("poNumber");



CREATE UNIQUE INDEX "Invoice_gmailMessageId_key" ON "public"."Invoice" USING "btree" ("gmailMessageId");



CREATE INDEX "Invoice_receivedAt_idx" ON "public"."Invoice" USING "btree" ("receivedAt");



CREATE INDEX "Invoice_status_idx" ON "public"."Invoice" USING "btree" ("status");



CREATE INDEX "Invoice_supplierId_idx" ON "public"."Invoice" USING "btree" ("supplierId");



CREATE INDEX "Order_orderDate_idx" ON "public"."Order" USING "btree" ("orderDate");



CREATE INDEX "Order_poNumber_idx" ON "public"."Order" USING "btree" ("poNumber");



CREATE UNIQUE INDEX "Order_spruceOrderId_key" ON "public"."Order" USING "btree" ("spruceOrderId");



CREATE INDEX "Order_supplierId_idx" ON "public"."Order" USING "btree" ("supplierId");



CREATE UNIQUE INDEX "Product_name_key" ON "public"."Product" USING "btree" ("name");



CREATE UNIQUE INDEX "SystemSetting_key_key" ON "public"."SystemSetting" USING "btree" ("key");



CREATE INDEX "TicketOrderMatch_matchMethod_idx" ON "public"."TicketOrderMatch" USING "btree" ("matchMethod");



CREATE INDEX "TicketOrderMatch_orderId_idx" ON "public"."TicketOrderMatch" USING "btree" ("orderId");



CREATE INDEX "TicketOrderMatch_ticketId_idx" ON "public"."TicketOrderMatch" USING "btree" ("ticketId");



CREATE UNIQUE INDEX "TicketOrderMatch_ticketId_orderId_key" ON "public"."TicketOrderMatch" USING "btree" ("ticketId", "orderId");



CREATE INDEX "Ticket_poNumber_idx" ON "public"."Ticket" USING "btree" ("poNumber");



CREATE INDEX "Ticket_receivedAt_idx" ON "public"."Ticket" USING "btree" ("receivedAt");



CREATE INDEX "Ticket_status_idx" ON "public"."Ticket" USING "btree" ("status");



CREATE INDEX "Ticket_supplierId_idx" ON "public"."Ticket" USING "btree" ("supplierId");



CREATE UNIQUE INDEX "Unit_name_key" ON "public"."Unit" USING "btree" ("name");



CREATE UNIQUE INDEX "User_email_key" ON "public"."User" USING "btree" ("email");



CREATE INDEX "_InvoiceLineItemToTicket_B_index" ON "public"."_InvoiceLineItemToTicket" USING "btree" ("B");



ALTER TABLE ONLY "public"."AuditLog"
    ADD CONSTRAINT "AuditLog_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "public"."User"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."DeliveryHistory"
    ADD CONSTRAINT "DeliveryHistory_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "public"."Delivery"("id") ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."Delivery"
    ADD CONSTRAINT "Delivery_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "public"."Driver"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."Delivery"
    ADD CONSTRAINT "Delivery_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."Order"("id") ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."Driver"
    ADD CONSTRAINT "Driver_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."EmailIngestionEvent"
    ADD CONSTRAINT "EmailIngestionEvent_createdInvoiceId_fkey" FOREIGN KEY ("createdInvoiceId") REFERENCES "public"."Invoice"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."EmailIngestionEvent"
    ADD CONSTRAINT "EmailIngestionEvent_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "public"."Supplier"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."InvoiceLineItem"
    ADD CONSTRAINT "InvoiceLineItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "public"."Invoice"("id") ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."InvoiceLineItem"
    ADD CONSTRAINT "InvoiceLineItem_matchedOrderId_fkey" FOREIGN KEY ("matchedOrderId") REFERENCES "public"."Order"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."Invoice"
    ADD CONSTRAINT "Invoice_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "public"."Supplier"("id") ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."Invoice"
    ADD CONSTRAINT "Invoice_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "public"."User"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."NegotiatedRate"
    ADD CONSTRAINT "NegotiatedRate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."NegotiatedRate"
    ADD CONSTRAINT "NegotiatedRate_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "public"."Supplier"("id") ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."OcrJob"
    ADD CONSTRAINT "OcrJob_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "public"."Invoice"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."OcrJob"
    ADD CONSTRAINT "OcrJob_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "public"."Ticket"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."Order"
    ADD CONSTRAINT "Order_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "public"."Driver"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."Order"
    ADD CONSTRAINT "Order_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "public"."Supplier"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."SpruceImportJob"
    ADD CONSTRAINT "SpruceImportJob_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "public"."User"("id") ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."SpruceImportRowError"
    ADD CONSTRAINT "SpruceImportRowError_importJobId_fkey" FOREIGN KEY ("importJobId") REFERENCES "public"."SpruceImportJob"("id") ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."SystemSetting"
    ADD CONSTRAINT "SystemSetting_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "public"."User"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."TicketOrderMatch"
    ADD CONSTRAINT "TicketOrderMatch_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."Order"("id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."TicketOrderMatch"
    ADD CONSTRAINT "TicketOrderMatch_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "public"."Ticket"("id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."Ticket"
    ADD CONSTRAINT "Ticket_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "public"."Driver"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."Ticket"
    ADD CONSTRAINT "Ticket_linkedById_fkey" FOREIGN KEY ("linkedById") REFERENCES "public"."User"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."Ticket"
    ADD CONSTRAINT "Ticket_linkedOrderId_fkey" FOREIGN KEY ("linkedOrderId") REFERENCES "public"."Order"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."Ticket"
    ADD CONSTRAINT "Ticket_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "public"."Supplier"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."WhatsAppMessage"
    ADD CONSTRAINT "WhatsAppMessage_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "public"."Driver"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."_InvoiceLineItemToTicket"
    ADD CONSTRAINT "_InvoiceLineItemToTicket_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."InvoiceLineItem"("id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."_InvoiceLineItemToTicket"
    ADD CONSTRAINT "_InvoiceLineItemToTicket_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."Ticket"("id") ON UPDATE CASCADE ON DELETE CASCADE;





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";






ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."Delivery";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."Invoice";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."Order";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."Ticket";



REVOKE USAGE ON SCHEMA "public" FROM PUBLIC;
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";





































































































































































GRANT ALL ON TABLE "public"."AuditLog" TO "anon";
GRANT ALL ON TABLE "public"."AuditLog" TO "authenticated";
GRANT ALL ON TABLE "public"."AuditLog" TO "service_role";



GRANT ALL ON TABLE "public"."Delivery" TO "anon";
GRANT ALL ON TABLE "public"."Delivery" TO "authenticated";
GRANT ALL ON TABLE "public"."Delivery" TO "service_role";



GRANT ALL ON TABLE "public"."DeliveryHistory" TO "anon";
GRANT ALL ON TABLE "public"."DeliveryHistory" TO "authenticated";
GRANT ALL ON TABLE "public"."DeliveryHistory" TO "service_role";



GRANT ALL ON TABLE "public"."Driver" TO "anon";
GRANT ALL ON TABLE "public"."Driver" TO "authenticated";
GRANT ALL ON TABLE "public"."Driver" TO "service_role";



GRANT ALL ON TABLE "public"."EmailIngestionEvent" TO "anon";
GRANT ALL ON TABLE "public"."EmailIngestionEvent" TO "authenticated";
GRANT ALL ON TABLE "public"."EmailIngestionEvent" TO "service_role";



GRANT ALL ON TABLE "public"."Invoice" TO "anon";
GRANT ALL ON TABLE "public"."Invoice" TO "authenticated";
GRANT ALL ON TABLE "public"."Invoice" TO "service_role";



GRANT ALL ON TABLE "public"."InvoiceLineItem" TO "anon";
GRANT ALL ON TABLE "public"."InvoiceLineItem" TO "authenticated";
GRANT ALL ON TABLE "public"."InvoiceLineItem" TO "service_role";



GRANT ALL ON TABLE "public"."NegotiatedRate" TO "anon";
GRANT ALL ON TABLE "public"."NegotiatedRate" TO "authenticated";
GRANT ALL ON TABLE "public"."NegotiatedRate" TO "service_role";



GRANT ALL ON TABLE "public"."OcrJob" TO "anon";
GRANT ALL ON TABLE "public"."OcrJob" TO "authenticated";
GRANT ALL ON TABLE "public"."OcrJob" TO "service_role";



GRANT ALL ON TABLE "public"."Order" TO "anon";
GRANT ALL ON TABLE "public"."Order" TO "authenticated";
GRANT ALL ON TABLE "public"."Order" TO "service_role";



GRANT ALL ON TABLE "public"."Product" TO "anon";
GRANT ALL ON TABLE "public"."Product" TO "authenticated";
GRANT ALL ON TABLE "public"."Product" TO "service_role";



GRANT ALL ON TABLE "public"."SpruceImportJob" TO "anon";
GRANT ALL ON TABLE "public"."SpruceImportJob" TO "authenticated";
GRANT ALL ON TABLE "public"."SpruceImportJob" TO "service_role";



GRANT ALL ON TABLE "public"."SpruceImportRowError" TO "anon";
GRANT ALL ON TABLE "public"."SpruceImportRowError" TO "authenticated";
GRANT ALL ON TABLE "public"."SpruceImportRowError" TO "service_role";



GRANT ALL ON TABLE "public"."Supplier" TO "anon";
GRANT ALL ON TABLE "public"."Supplier" TO "authenticated";
GRANT ALL ON TABLE "public"."Supplier" TO "service_role";



GRANT ALL ON TABLE "public"."SystemSetting" TO "anon";
GRANT ALL ON TABLE "public"."SystemSetting" TO "authenticated";
GRANT ALL ON TABLE "public"."SystemSetting" TO "service_role";



GRANT ALL ON TABLE "public"."Ticket" TO "anon";
GRANT ALL ON TABLE "public"."Ticket" TO "authenticated";
GRANT ALL ON TABLE "public"."Ticket" TO "service_role";



GRANT ALL ON TABLE "public"."TicketOrderMatch" TO "anon";
GRANT ALL ON TABLE "public"."TicketOrderMatch" TO "authenticated";
GRANT ALL ON TABLE "public"."TicketOrderMatch" TO "service_role";



GRANT ALL ON TABLE "public"."Unit" TO "anon";
GRANT ALL ON TABLE "public"."Unit" TO "authenticated";
GRANT ALL ON TABLE "public"."Unit" TO "service_role";



GRANT ALL ON TABLE "public"."User" TO "anon";
GRANT ALL ON TABLE "public"."User" TO "authenticated";
GRANT ALL ON TABLE "public"."User" TO "service_role";



GRANT ALL ON TABLE "public"."WhatsAppMessage" TO "anon";
GRANT ALL ON TABLE "public"."WhatsAppMessage" TO "authenticated";
GRANT ALL ON TABLE "public"."WhatsAppMessage" TO "service_role";



GRANT ALL ON TABLE "public"."_InvoiceLineItemToTicket" TO "anon";
GRANT ALL ON TABLE "public"."_InvoiceLineItemToTicket" TO "authenticated";
GRANT ALL ON TABLE "public"."_InvoiceLineItemToTicket" TO "service_role";



GRANT ALL ON TABLE "public"."_prisma_migrations" TO "anon";
GRANT ALL ON TABLE "public"."_prisma_migrations" TO "authenticated";
GRANT ALL ON TABLE "public"."_prisma_migrations" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";




























drop extension if exists "pg_net";


