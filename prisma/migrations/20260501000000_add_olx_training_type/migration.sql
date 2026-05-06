-- AlterEnum: add OLX training types
ALTER TYPE "TrainingType" ADD VALUE 'OLX';
ALTER TYPE "TrainingType" ADD VALUE 'OLX Sub-Item';

-- CreateTable: olx_sub_item_relations (parent OLX ↔ sub-item, many-to-many)
CREATE TABLE "olx_sub_item_relations" (
    "parent_training_title" TEXT NOT NULL,
    "sub_item_training_title" TEXT NOT NULL,

    CONSTRAINT "olx_sub_item_relations_pkey" PRIMARY KEY ("parent_training_title", "sub_item_training_title")
);

-- CreateIndex
CREATE INDEX "olx_sub_item_relations_sub_item_training_title_idx" ON "olx_sub_item_relations"("sub_item_training_title");

-- AddForeignKey
ALTER TABLE "olx_sub_item_relations" ADD CONSTRAINT "olx_sub_item_relations_parent_training_title_fkey" FOREIGN KEY ("parent_training_title") REFERENCES "training_data"("training_title") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "olx_sub_item_relations" ADD CONSTRAINT "olx_sub_item_relations_sub_item_training_title_fkey" FOREIGN KEY ("sub_item_training_title") REFERENCES "training_data"("training_title") ON DELETE CASCADE ON UPDATE CASCADE;
