ALTER TABLE "businesses" ADD COLUMN "panel_token" varchar(64);--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "qualification" text DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "human_takeover_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sender_type" text DEFAULT 'bot' NOT NULL;--> statement-breakpoint
CREATE INDEX "conversations_business_id_qualification_idx" ON "conversations" USING btree ("business_id","qualification");--> statement-breakpoint
CREATE INDEX "conversations_human_takeover_at_idx" ON "conversations" USING btree ("human_takeover_at");--> statement-breakpoint
-- Backfill sender_type for rows written before the column existed.
-- A 'user' turn in a customer thread came from the customer; the same turn in
-- an owner_thread came from the owner typing on WhatsApp, which is a human.
-- Everything else (assistant/tool/system) keeps the 'bot' default.
UPDATE "messages" SET "sender_type" = 'customer'
  WHERE "role" = 'user'
    AND "conversation_id" IN (SELECT "id" FROM "conversations" WHERE "type" = 'customer');--> statement-breakpoint
UPDATE "messages" SET "sender_type" = 'human'
  WHERE "role" = 'user'
    AND "conversation_id" IN (SELECT "id" FROM "conversations" WHERE "type" = 'owner_thread');--> statement-breakpoint
-- Backfill panel_token for businesses that predate the panel. Two UUIDs with
-- the dashes stripped is 64 hex chars / 256 bits of entropy from pgcrypto's
-- CSPRNG — the same shape business.service mints for new businesses.
UPDATE "businesses"
  SET "panel_token" = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
  WHERE "panel_token" IS NULL;
