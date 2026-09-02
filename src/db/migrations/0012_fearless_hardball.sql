CREATE TABLE "payment_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"service" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"deposit_amount" text,
	"customer_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"appointment_id" text,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "payment_verifications" ADD CONSTRAINT "payment_verifications_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_verifications" ADD CONSTRAINT "payment_verifications_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_verifications" ADD CONSTRAINT "payment_verifications_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_verifications" ADD CONSTRAINT "payment_verifications_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_verifications_business_id_idx" ON "payment_verifications" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "payment_verifications_business_id_conversation_id_idx" ON "payment_verifications" USING btree ("business_id","conversation_id");