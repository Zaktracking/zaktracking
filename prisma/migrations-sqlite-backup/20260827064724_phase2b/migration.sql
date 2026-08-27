-- AlterTable
ALTER TABLE "OrderRecord" ADD COLUMN "address" TEXT;
ALTER TABLE "OrderRecord" ADD COLUMN "city" TEXT;
ALTER TABLE "OrderRecord" ADD COLUMN "itemLine" TEXT;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN "abandonCode" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Shipment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "fulfillmentId" TEXT NOT NULL,
    "trackingNo" TEXT,
    "carrier" TEXT,
    "carrierCode" TEXT,
    "trackUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lastEventAt" DATETIME,
    "registered" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "subStatus" TEXT,
    "lastEventDesc" TEXT,
    "lastEventLoc" TEXT,
    "scans" TEXT,
    "regTries" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Shipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "OrderRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Shipment" ("carrier", "carrierCode", "createdAt", "fulfillmentId", "id", "lastEventAt", "orderId", "registered", "status", "trackUrl", "trackingNo", "updatedAt") SELECT "carrier", "carrierCode", "createdAt", "fulfillmentId", "id", "lastEventAt", "orderId", "registered", "status", "trackUrl", "trackingNo", "updatedAt" FROM "Shipment";
DROP TABLE "Shipment";
ALTER TABLE "new_Shipment" RENAME TO "Shipment";
CREATE INDEX "Shipment_trackingNo_idx" ON "Shipment"("trackingNo");
CREATE UNIQUE INDEX "Shipment_orderId_fulfillmentId_key" ON "Shipment"("orderId", "fulfillmentId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
