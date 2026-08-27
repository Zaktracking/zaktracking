-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "waEnabled" BOOLEAN NOT NULL DEFAULT false,
    "waPhoneNumberId" TEXT,
    "waWabaId" TEXT,
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
    "codConfirm" BOOLEAN NOT NULL DEFAULT true,
    "abandonCode" TEXT,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderRecord" (
    "id" TEXT NOT NULL,
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
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "itemLine" TEXT,
    "city" TEXT,
    "address" TEXT,

    CONSTRAINT "OrderRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shipment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fulfillmentId" TEXT NOT NULL,
    "trackingNo" TEXT,
    "carrier" TEXT,
    "carrierCode" TEXT,
    "trackUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lastEventAt" TIMESTAMP(3),
    "registered" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "subStatus" TEXT,
    "lastEventDesc" TEXT,
    "lastEventLoc" TEXT,
    "scans" TEXT,
    "regTries" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageLog" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT,
    "channel" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "providerId" TEXT,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Template" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "body" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AbandonedCart" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "phone" TEXT,
    "name" TEXT,
    "recoverUrl" TEXT,
    "total" TEXT,
    "currency" TEXT,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reminder1At" TIMESTAMP(3),
    "reminder2At" TIMESTAMP(3),
    "convertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbandonedCart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptOut" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OptOut_pkey" PRIMARY KEY ("id")
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

-- CreateIndex
CREATE INDEX "OptOut_shopId_idx" ON "OptOut"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "OptOut_shopId_phone_key" ON "OptOut"("shopId", "phone");

-- AddForeignKey
ALTER TABLE "OrderRecord" ADD CONSTRAINT "OrderRecord_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "OrderRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageLog" ADD CONSTRAINT "MessageLog_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageLog" ADD CONSTRAINT "MessageLog_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "OrderRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Template" ADD CONSTRAINT "Template_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbandonedCart" ADD CONSTRAINT "AbandonedCart_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
