ALTER TABLE "conversations" ALTER COLUMN "customer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "owner_whatsapp_number" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "owner_name" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "type" text DEFAULT 'customer' NOT NULL;--> statement-breakpoint
CREATE INDEX "businesses_owner_whatsapp_number_idx" ON "businesses" USING btree ("owner_whatsapp_number");--> statement-breakpoint
CREATE INDEX "conversations_business_id_type_idx" ON "conversations" USING btree ("business_id","type");