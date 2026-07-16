-- Secure bot binding: one-time code in the t.me deep link.
ALTER TABLE "Client" ADD COLUMN "telegramBindCode" TEXT;
-- Calendar companion reminders: link to the event + remember the lead.
ALTER TABLE "Task" ADD COLUMN "sourceEventId" TEXT;
ALTER TABLE "Task" ADD COLUMN "reminderLeadMinutes" INTEGER;
CREATE INDEX "Task_clientId_sourceEventId_idx" ON "Task"("clientId", "sourceEventId");
