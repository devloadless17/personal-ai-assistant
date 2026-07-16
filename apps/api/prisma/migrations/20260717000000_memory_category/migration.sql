-- Categorized memory: profile / preference / long-term, for a client-facing
-- "what the assistant knows about me" page.
CREATE TYPE "MemoryCategory" AS ENUM ('PROFILE', 'PREFERENCE', 'LONGTERM');

ALTER TABLE "Memory" ADD COLUMN "category" "MemoryCategory" NOT NULL DEFAULT 'LONGTERM';
