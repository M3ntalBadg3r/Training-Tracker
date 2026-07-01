-- Audit log of rejected authentication attempts (login + public API), surfaced
-- to SuperAdmins on the Users and API Keys admin pages.

CREATE TABLE "failed_attempts" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "key_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "failed_attempts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "failed_attempts_kind_created_at_idx" ON "failed_attempts"("kind", "created_at");

CREATE INDEX "failed_attempts_ip_idx" ON "failed_attempts"("ip");
