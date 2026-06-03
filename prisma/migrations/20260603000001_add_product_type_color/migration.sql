-- Add optional brand colour (hex #RRGGBB) to ProductType so charts can render
-- each product in its dominant colour. Null = chart falls back to neutral grey.
ALTER TABLE "product_types"
  ADD COLUMN "color" VARCHAR(7);

ALTER TABLE "product_types"
  ADD CONSTRAINT "product_types_color_hex_check"
  CHECK ("color" IS NULL OR "color" ~ '^#[0-9a-f]{6}$');
