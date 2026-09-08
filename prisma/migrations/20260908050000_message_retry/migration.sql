-- AlterTable
ALTER TABLE "MessageLog" ADD COLUMN     "vars" TEXT,
ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "nextTryAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "MessageLog_nextTryAt_idx" ON "MessageLog"("nextTryAt");
