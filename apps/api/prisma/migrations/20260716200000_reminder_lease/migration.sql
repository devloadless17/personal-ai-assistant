-- At-least-once reminder delivery: a lease timestamp so a reminder claimed for
-- sending but interrupted (crash/redeploy) is re-claimed by a later tick
-- instead of being silently marked sent-but-never-delivered.
ALTER TABLE "Task" ADD COLUMN "reminderClaimedAt" TIMESTAMP(3);
