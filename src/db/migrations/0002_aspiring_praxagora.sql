CREATE TABLE "google_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"token_expires_at" timestamp with time zone NOT NULL,
	"calendar_id" text DEFAULT 'primary' NOT NULL,
	"connected_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_credentials_business_id_unique" UNIQUE("business_id")
);
--> statement-breakpoint
ALTER TABLE "google_credentials" ADD CONSTRAINT "google_credentials_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;