-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "formEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "otpChannel" TEXT,
ADD COLUMN     "otpTemplate" TEXT,
ADD COLUMN     "prepaidCode" TEXT,
ADD COLUMN     "prepaidOff" TEXT,
ADD COLUMN     "smsRoute" TEXT;

-- CreateTable
CREATE TABLE "OtpCode" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3),

    CONSTRAINT "OtpCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OtpCode_shopId_phone_idx" ON "OtpCode"("shopId", "phone");

-- CreateIndex
CREATE INDEX "OtpCode_expiresAt_idx" ON "OtpCode"("expiresAt");

-- AddForeignKey
ALTER TABLE "OtpCode" ADD CONSTRAINT "OtpCode_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
