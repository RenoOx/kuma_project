CREATE TYPE "public"."kb_attachment_type" AS ENUM('none', 'link', 'image', 'pdf', 'video');--> statement-breakpoint
CREATE TYPE "public"."kb_category" AS ENUM('ubicacion', 'servicios', 'precios', 'politicas', 'contacto', 'informacion_general');--> statement-breakpoint
CREATE TYPE "public"."kb_send_mode" AS ENUM('always', 'on_request', 'trigger_based');--> statement-breakpoint

-- ── Structure: additive only, safe on a live table ───────────────────────────
-- `title` lands nullable here and is tightened to NOT NULL at the bottom, after
-- the backfill. Generated drizzle SQL added it NOT NULL up front, which fails
-- on any pre-existing row.
ALTER TABLE "knowledge_base" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD COLUMN "attachment_type" "kb_attachment_type" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD COLUMN "attachment_url" text;--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD COLUMN "send_mode" "kb_send_mode" DEFAULT 'on_request' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD COLUMN "trigger_keywords" text[];--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD COLUMN "priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD COLUMN "embedding" jsonb;--> statement-breakpoint

-- ── Backfill of existing rows ────────────────────────────────────────────────
-- Title is derived from the first 50 chars of the content, as agreed.
UPDATE "knowledge_base" SET "title" = left("content", 50) WHERE "title" IS NULL;--> statement-breakpoint

-- Free-text categories collapse onto the fixed enum. Anything that does not map
-- cleanly becomes 'informacion_general' rather than blocking the migration.
UPDATE "knowledge_base" SET "category" = CASE lower(trim("category"))
    WHEN 'ubicacion' THEN 'ubicacion'
    WHEN 'ubicación' THEN 'ubicacion'
    WHEN 'location' THEN 'ubicacion'
    WHEN 'direccion' THEN 'ubicacion'
    WHEN 'dirección' THEN 'ubicacion'
    WHEN 'servicios' THEN 'servicios'
    WHEN 'services' THEN 'servicios'
    WHEN 'precios' THEN 'precios'
    WHEN 'pricing' THEN 'precios'
    WHEN 'prices' THEN 'precios'
    WHEN 'politicas' THEN 'politicas'
    WHEN 'políticas' THEN 'politicas'
    WHEN 'policies' THEN 'politicas'
    WHEN 'contacto' THEN 'contacto'
    WHEN 'contact' THEN 'contacto'
    WHEN 'informacion_general' THEN 'informacion_general'
    ELSE 'informacion_general'
  END;--> statement-breakpoint

-- ── Tighten: only safe now that every row has a title and a valid category ───
ALTER TABLE "knowledge_base" ALTER COLUMN "category" SET DATA TYPE "public"."kb_category" USING "category"::"public"."kb_category";--> statement-breakpoint
ALTER TABLE "knowledge_base" ALTER COLUMN "title" SET NOT NULL;--> statement-breakpoint

CREATE INDEX "knowledge_base_business_category_idx" ON "knowledge_base" USING btree ("business_id","category","priority");
