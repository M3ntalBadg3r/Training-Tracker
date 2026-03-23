-- CreateTable
CREATE TABLE "import_metadata" (
    "key" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_metadata_pkey" PRIMARY KEY ("key")
);
