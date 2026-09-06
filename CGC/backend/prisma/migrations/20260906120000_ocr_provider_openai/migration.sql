-- Records which service actually read a document.
--
-- Extraction moved off AWS Textract + Bedrock onto a single vision-model call.
-- The old values stay: rows written before this change were genuinely produced
-- by Textract, and rewriting that history would misreport how those fields were
-- obtained.
ALTER TYPE "OcrProvider" ADD VALUE IF NOT EXISTS 'OPENAI';
