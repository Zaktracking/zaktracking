-- AlterTable
ALTER TABLE "Shop" ADD COLUMN "waWabaId" TEXT;

-- CreateTable
CREATE TABLE "OptOut" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "OptOut_shopId_idx" ON "OptOut"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "OptOut_shopId_phone_key" ON "OptOut"("shopId", "phone");
