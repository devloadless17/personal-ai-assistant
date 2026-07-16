-- Recurring reminders/tasks: the reminder cron re-arms the same row to the next
-- occurrence instead of marking it permanently sent.
CREATE TYPE "RecurrenceFreq" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

ALTER TABLE "Task"
  ADD COLUMN "recurrenceFreq" "RecurrenceFreq",
  ADD COLUMN "recurrenceInterval" INTEGER DEFAULT 1,
  ADD COLUMN "recurrenceWeekdays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN "recurrenceUntil" TIMESTAMP(3);
