-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "dailyBriefHour" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "lastBriefDate" TEXT;
