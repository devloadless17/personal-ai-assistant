-- Indexes for admin-only list/diagnostics ordering (avoid full-scan+sort at scale).
CREATE INDEX "Client_createdAt_idx" ON "Client"("createdAt");
CREATE INDEX "Task_reminderAt_idx" ON "Task"("reminderAt");
