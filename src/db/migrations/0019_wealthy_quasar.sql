CREATE TABLE "service_media" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"service_id" text NOT NULL,
	"s3_key" text NOT NULL,
	"type" text NOT NULL,
	"filename" text,
	"mimetype" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_media" ADD CONSTRAINT "service_media_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_media_business_service_idx" ON "service_media" USING btree ("business_id","service_id","display_order");--> statement-breakpoint
CREATE INDEX "service_media_business_id_idx" ON "service_media" USING btree ("business_id");