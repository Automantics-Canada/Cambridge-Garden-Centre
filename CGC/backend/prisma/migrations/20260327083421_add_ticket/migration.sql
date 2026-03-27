/*
  Warnings:

  - You are about to drop the column `ocrStatus` on the `Invoice` table. All the data in the column will be lost.
  - You are about to drop the column `targetType` on the `OcrJob` table. All the data in the column will be lost.
  - The `status` column on the `OcrJob` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Added the required column `type` to the `OcrJob` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "LinkMethod" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "OcrJobType" AS ENUM ('TICKET', 'INVOICE');

-- CreateEnum
CREATE TYPE "OcrJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "Invoice" DROP COLUMN "ocrStatus",
ADD COLUMN     "OcrJobStatus" "OcrJobStatus" NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "OcrJob" DROP COLUMN "targetType",
ADD COLUMN     "type" "OcrJobType" NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "OcrJobStatus" NOT NULL DEFAULT 'PENDING';

-- DropEnum
DROP TYPE "OcrStatus";

-- DropEnum
DROP TYPE "OcrTargetType";
