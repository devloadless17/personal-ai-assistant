-- Travel-aware timezone tracking.
-- `timezone` stays the CURRENT effective zone (read live everywhere); the new
-- columns let it follow a traveler via Google-Calendar sync + conversation.
ALTER TABLE "Client" ADD COLUMN "homeTimezone" TEXT;
ALTER TABLE "Client" ADD COLUMN "googleTimezone" TEXT;
ALTER TABLE "Client" ADD COLUMN "timezonePinned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Client" ADD COLUMN "timezoneSource" TEXT;
ALTER TABLE "Client" ADD COLUMN "timezoneUpdatedAt" TIMESTAMP(3);
ALTER TABLE "Client" ADD COLUMN "lastTimezoneSyncAt" TIMESTAMP(3);

-- Monotonic guard so a westward move can't double-send the daily brief.
ALTER TABLE "Client" ADD COLUMN "lastBriefAt" TIMESTAMP(3);

-- Every existing client's current zone IS their home zone.
UPDATE "Client" SET "homeTimezone" = "timezone" WHERE "homeTimezone" IS NULL;

-- Client-customizable default meeting length (minutes), overridable per event.
ALTER TABLE "Client" ADD COLUMN "defaultMeetingMinutes" INTEGER NOT NULL DEFAULT 60;

-- Pin a recurring reminder to a fixed zone ("8am Beirut daily"); null = follow
-- the client's current zone.
ALTER TABLE "Task" ADD COLUMN "recurrenceTimezone" TEXT;
