-- Proactive double-booking alerts: de-dup table so the background calendar sweep
-- alerts a client once per distinct conflict rather than every tick.
CREATE TABLE "CalendarConflictAlert" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "conflictKey" TEXT NOT NULL,
    "alertedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CalendarConflictAlert_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CalendarConflictAlert_clientId_conflictKey_key" ON "CalendarConflictAlert"("clientId", "conflictKey");
CREATE INDEX "CalendarConflictAlert_clientId_alertedAt_idx" ON "CalendarConflictAlert"("clientId", "alertedAt");

ALTER TABLE "CalendarConflictAlert" ADD CONSTRAINT "CalendarConflictAlert_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
