ALTER TABLE "appointments" ADD COLUMN "reminder_24h_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "reminder_2h_sent_at" timestamp with time zone;