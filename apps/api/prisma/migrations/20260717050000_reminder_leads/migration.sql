-- Per-client reminder lead times (minutes before a meeting) — one Telegram ping
-- per value, so a client can have several reminders (e.g. an hour before AND ten
-- minutes before) or just one. Replaces the single defaultReminderMinutes.
ALTER TABLE "Client" ADD COLUMN "reminderLeads" INTEGER[] NOT NULL DEFAULT ARRAY[60, 10];

-- Backfill: every client gets the new default (1h + 10m) EXCEPT those who had
-- reminders turned off (defaultReminderMinutes = 0), whose choice is preserved.
UPDATE "Client" SET "reminderLeads" = ARRAY[]::integer[] WHERE "defaultReminderMinutes" = 0;
