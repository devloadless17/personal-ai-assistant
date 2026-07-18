-- Record EVERYTHING the system sends a client (reminder pings, daily brief,
-- conflict/timezone notices), not just the chat back-and-forth, so an admin can
-- see exactly what the client received. `kind` tells the sources apart.
CREATE TYPE "MessageKind" AS ENUM ('chat', 'reminder', 'brief', 'alert');

-- Existing rows are all conversational (only the chat path recorded messages
-- before this), so the `chat` default backfills them correctly.
ALTER TABLE "Message" ADD COLUMN "kind" "MessageKind" NOT NULL DEFAULT 'chat';

-- Admin log filtering: "show me only this client's reminders", newest first.
CREATE INDEX "Message_clientId_kind_createdAt_idx" ON "Message"("clientId", "kind", "createdAt");
