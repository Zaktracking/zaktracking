-- AlterTable
ALTER TABLE "OtpCode" ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'self',
ADD COLUMN     "ref" TEXT;
