-- "This meeting should have NO reminders" markers. The calendar sweep auto-arms
-- reminders for meetings added directly in the Google Calendar app; this table
-- lets it distinguish "never had reminders" from "the client deliberately turned
-- them off", so it can never silently re-add pings the client just cancelled.
CREATE TABLE "EventReminderOptOut" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventReminderOptOut_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EventReminderOptOut_clientId_eventId_key" ON "EventReminderOptOut"("clientId", "eventId");
CREATE INDEX "EventReminderOptOut_clientId_idx" ON "EventReminderOptOut"("clientId");

ALTER TABLE "EventReminderOptOut" ADD CONSTRAINT "EventReminderOptOut_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
