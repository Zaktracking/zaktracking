-- AlterTable
ALTER TABLE "OrderRecord" ADD COLUMN     "cancelRequestedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "autoCancel" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "cancelGraceMin" INTEGER NOT NULL DEFAULT 30;

-- CreateTable
CREATE TABLE "InboundMessage" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT,
    "waMessageId" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "intent" TEXT NOT NULL DEFAULT 'none',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InboundMessage_waMessageId_key" ON "InboundMessage"("waMessageId");

-- CreateIndex
CREATE INDEX "InboundMessage_shopId_createdAt_idx" ON "InboundMessage"("shopId", "createdAt");

-- AddForeignKey
ALTER TABLE "InboundMessage" ADD CONSTRAINT "InboundMessage_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundMessage" ADD CONSTRAINT "InboundMessage_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "OrderRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;
