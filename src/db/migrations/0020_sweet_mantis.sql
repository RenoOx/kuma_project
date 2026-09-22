DROP INDEX "service_media_business_service_idx";--> statement-breakpoint
ALTER TABLE "service_media" ADD COLUMN "owner_kind" text DEFAULT 'service' NOT NULL;--> statement-breakpoint
CREATE INDEX "service_media_business_service_idx" ON "service_media" USING btree ("business_id","owner_kind","service_id","display_order");