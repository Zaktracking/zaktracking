-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "onCodConfirm" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "onCodReminder" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "onCodConfirmed" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "codReminderHours" INTEGER NOT NULL DEFAULT 6,
ADD COLUMN     "autoConfirm" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "autoConfirmMin" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "ownerPhone" TEXT,
ADD COLUMN     "ownerAlerts" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "OrderRecord" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "changeNote" TEXT;

-- AlterTable
ALTER TABLE "InboundMessage" ADD COLUMN     "reply" TEXT,
ADD COLUMN     "forwarded" BOOLEAN NOT NULL DEFAULT false;
