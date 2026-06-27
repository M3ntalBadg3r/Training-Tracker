-- Read-only public API keys. Each key authenticates third-party systems via an
-- `Authorization: Bearer` header; only the SHA-256 hash is stored. A key is
-- scoped to one or more companies via the api_key_companies join table.

-- CreateTable: api_keys
CREATE TABLE "api_keys" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "expires_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "last_used_ip" TEXT,
    "revoked_at" TIMESTAMP(3),
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

CREATE INDEX "api_keys_key_hash_idx" ON "api_keys"("key_hash");

-- CreateTable: api_key_companies (many-to-many api_key <-> company)
CREATE TABLE "api_key_companies" (
    "api_key_id" INTEGER NOT NULL,
    "company_id" INTEGER NOT NULL,

    CONSTRAINT "api_key_companies_pkey" PRIMARY KEY ("api_key_id", "company_id")
);

CREATE INDEX "api_key_companies_company_id_idx" ON "api_key_companies"("company_id");

ALTER TABLE "api_key_companies"
    ADD CONSTRAINT "api_key_companies_api_key_id_fkey"
    FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "api_key_companies"
    ADD CONSTRAINT "api_key_companies_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
