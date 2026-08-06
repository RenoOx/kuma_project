CREATE TABLE "whatsapp_session_guard" (
	"id" text PRIMARY KEY NOT NULL,
	"whatsapp_number" text NOT NULL,
	"business_id" text,
	"last_pairing_code_at" timestamp with time zone,
	"last_restart_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"attempt_window_started_at" timestamp with time zone,
	"blocked_until" timestamp with time zone,
	"halt_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_session_guard_whatsapp_number_unique" UNIQUE("whatsapp_number")
);
--> statement-breakpoint
ALTER TABLE "whatsapp_session_guard" ADD CONSTRAINT "whatsapp_session_guard_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE set null ON UPDATE no action;