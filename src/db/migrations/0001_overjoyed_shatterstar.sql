CREATE TABLE "appointments" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"service" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"duration_minutes" integer DEFAULT 30 NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"google_event_id" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"conversation_id" text,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"business_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"tool_calls" jsonb,
	"tool_call_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointments_business_id_idx" ON "appointments" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "appointments_customer_id_idx" ON "appointments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "appointments_scheduled_at_idx" ON "appointments" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "appointments_business_id_scheduled_at_idx" ON "appointments" USING btree ("business_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "conversations_business_id_idx" ON "conversations" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "conversations_customer_id_idx" ON "conversations" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "conversations_last_message_at_idx" ON "conversations" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX "conversations_business_id_status_idx" ON "conversations" USING btree ("business_id","status");--> statement-breakpoint
CREATE INDEX "events_business_id_idx" ON "events" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "events_conversation_id_idx" ON "events" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "events_created_at_idx" ON "events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_id_idx" ON "messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "messages_business_id_idx" ON "messages" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "messages_created_at_idx" ON "messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages" USING btree ("conversation_id","created_at");