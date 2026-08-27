-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "domain" TEXT NOT NULL,
    "installedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "waEnabled" BOOLEAN NOT NULL DEFAULT false,
    "waPhoneNumberId" TEXT,
    "waToken" TEXT,
    "smsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "smsApiKey" TEXT,
    "smsSenderId" TEXT,
    "trackApiKey" TEXT,
    "onOrderCreate" BOOLEAN NOT NULL DEFAULT true,
    "onOrderPaid" BOOLEAN NOT NULL DEFAULT true,
    "onFulfilled" BOOLEAN NOT NULL DEFAULT true,
    "onOutForDelivery" BOOLEAN NOT NULL DEFAULT true,
    "onDelivered" BOOLEAN NOT NULL DEFAULT true,
    "onCancelled" BOOLEAN NOT NULL DEFAULT true,
    "onAbandoned" BOOLEAN NOT NULL DEFAULT false,
    "codConfirm" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "OrderRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "shopifyId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "customerName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "totalPrice" TEXT,
    "currency" TEXT,
    "financial" TEXT,
    "gateway" TEXT,
    "isCod" BOOLEAN NOT NULL DEFAULT false,
    "codConfirmed" BOOLEAN,
    "cancelledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OrderRecord_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Shipment" (
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
    CONSTRAINT "Shipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "OrderRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MessageLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT,
    "channel" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "providerId" TEXT,
    "error" TEXT,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MessageLog_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MessageLog_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "OrderRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Template" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "body" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Template_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AbandonedCart" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "phone" TEXT,
    "name" TEXT,
    "recoverUrl" TEXT,
    "total" TEXT,
    "currency" TEXT,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reminder1At" DATETIME,
    "reminder2At" DATETIME,
    "convertedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AbandonedCart_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "topic" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_domain_key" ON "Shop"("domain");

-- CreateIndex
CREATE INDEX "OrderRecord_shopId_createdAt_idx" ON "OrderRecord"("shopId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderRecord_shopId_shopifyId_key" ON "OrderRecord"("shopId", "shopifyId");

-- CreateIndex
CREATE INDEX "Shipment_trackingNo_idx" ON "Shipment"("trackingNo");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_orderId_fulfillmentId_key" ON "Shipment"("orderId", "fulfillmentId");

-- CreateIndex
CREATE INDEX "MessageLog_shopId_createdAt_idx" ON "MessageLog"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "MessageLog_status_idx" ON "MessageLog"("status");

-- CreateIndex
CREATE UNIQUE INDEX "MessageLog_orderId_event_channel_key" ON "MessageLog"("orderId", "event", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "Template_shopId_event_channel_key" ON "Template"("shopId", "event", "channel");

-- CreateIndex
CREATE INDEX "AbandonedCart_shopId_lastSeenAt_idx" ON "AbandonedCart"("shopId", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "AbandonedCart_shopId_token_key" ON "AbandonedCart"("shopId", "token");

-- CreateIndex
CREATE INDEX "WebhookEvent_shop_topic_idx" ON "WebhookEvent"("shop", "topic");
