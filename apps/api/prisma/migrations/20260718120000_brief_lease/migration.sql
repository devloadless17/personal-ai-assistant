-- Daily-brief LEASE. The brief previously marked itself sent BEFORE delivering,
-- with a JS-only revert: a restart/OOM between claim and send permanently
-- skipped that client's brief for the day, while diagnostics still showed it as
-- delivered. A separate claim column makes the job at-least-once — matching the
-- reminder job — because "sent" state is only advanced after a confirmed send.
ALTER TABLE "Client" ADD COLUMN "briefClaimedAt" TIMESTAMP(3);
