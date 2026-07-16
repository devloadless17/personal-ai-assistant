-- Recurrence anchor (fixes monthly month-end drift) + scale indexes.
ALTER TABLE "Task" ADD COLUMN "recurrenceAnchor" TIMESTAMP(3);

-- Index-satisfy the memory profile sort (orderBy updatedAt desc).
CREATE INDEX "Memory_clientId_updatedAt_idx" ON "Memory"("clientId", "updatedAt");

-- Support the conflict-alert TTL cleanup (deleteMany where alertedAt < cutoff).
CREATE INDEX "CalendarConflictAlert_alertedAt_idx" ON "CalendarConflictAlert"("alertedAt");
