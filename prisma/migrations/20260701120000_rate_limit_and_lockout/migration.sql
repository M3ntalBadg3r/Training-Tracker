-- Brute-force hardening: a persistent, shared rate-limit store plus per-account
-- lockout tracking on users.

-- CreateTable: rate_limit_buckets (backs lib/rate-limit.ts)
CREATE TABLE "rate_limit_buckets" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "reset_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "rate_limit_buckets_reset_at_idx" ON "rate_limit_buckets"("reset_at");

-- Per-account lockout columns on users.
ALTER TABLE "users" ADD COLUMN "failed_login_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "locked_until" TIMESTAMP(3);
