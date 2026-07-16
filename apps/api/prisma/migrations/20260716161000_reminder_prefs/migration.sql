-- Per-client default reminder lead time (minutes before due).
ALTER TABLE "Client" ADD COLUMN "defaultReminderMinutes" INTEGER NOT NULL DEFAULT 15;
