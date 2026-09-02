-- AlterTable
ALTER TABLE "OrderRecord" ADD COLUMN     "handle" TEXT;

-- CreateTable
CREATE TABLE "StockAlert" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "price" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMP(3),

    CONSTRAINT "StockAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockAlert_shopId_variantId_idx" ON "StockAlert"("shopId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "StockAlert_shopId_phone_variantId_key" ON "StockAlert"("shopId", "phone", "variantId");
