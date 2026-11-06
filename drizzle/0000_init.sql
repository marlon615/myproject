CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contractor_id" uuid NOT NULL,
	"conversation_id" uuid,
	"customer_name" text NOT NULL,
	"phone" text NOT NULL,
	"address" text NOT NULL,
	"issue" text NOT NULL,
	"urgency" text NOT NULL,
	"source" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'booked' NOT NULL,
	"reminder_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contractor_id" uuid NOT NULL,
	"conversation_id" uuid,
	"call_sid" text NOT NULL,
	"from_phone" text NOT NULL,
	"to_phone" text NOT NULL,
	"forwarded_from" text,
	"status" text DEFAULT 'in-progress' NOT NULL,
	"outcome" text,
	"duration_sec" integer,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contractors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_name" text NOT NULL,
	"owner_name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"business_phone" text NOT NULL,
	"alert_phone" text NOT NULL,
	"ai_number" text,
	"twilio_number_sid" text,
	"service_area" text,
	"timezone" text DEFAULT 'America/Chicago' NOT NULL,
	"hours_start" integer DEFAULT 8 NOT NULL,
	"hours_end" integer DEFAULT 17 NOT NULL,
	"work_days" text DEFAULT '1,2,3,4,5' NOT NULL,
	"slot_minutes" integer DEFAULT 120 NOT NULL,
	"jobs_per_slot" integer DEFAULT 1 NOT NULL,
	"emergency_dispatch" boolean DEFAULT true NOT NULL,
	"emergency_note" text,
	"calendar_token" text NOT NULL,
	"trial_ends_at" timestamp with time zone NOT NULL,
	"subscription_status" text,
	"paypal_subscription_id" text,
	"current_period_end" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contractor_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"channel" text NOT NULL,
	"step" text DEFAULT 'issue' NOT NULL,
	"urgency" text DEFAULT 'unknown' NOT NULL,
	"hazard" text,
	"customer_name" text,
	"address" text,
	"issue" text,
	"time_pref" text,
	"offered_slots" jsonb,
	"offer_round" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"alerted_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "optouts" (
	"contractor_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contractor_id" uuid,
	"paypal_id" text NOT NULL,
	"subscription_id" text,
	"event_type" text NOT NULL,
	"status" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "texts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contractor_id" uuid NOT NULL,
	"conversation_id" uuid,
	"direction" text NOT NULL,
	"phone" text NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"provider" text,
	"provider_message_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optouts" ADD CONSTRAINT "optouts_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "texts" ADD CONSTRAINT "texts_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "texts" ADD CONSTRAINT "texts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookings_contractor_idx" ON "bookings" USING btree ("contractor_id","starts_at");--> statement-breakpoint
CREATE INDEX "bookings_created_idx" ON "bookings" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "calls_sid_idx" ON "calls" USING btree ("call_sid");--> statement-breakpoint
CREATE INDEX "calls_contractor_idx" ON "calls" USING btree ("contractor_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contractors_email_idx" ON "contractors" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "contractors_ai_number_idx" ON "contractors" USING btree ("ai_number");--> statement-breakpoint
CREATE UNIQUE INDEX "contractors_calendar_token_idx" ON "contractors" USING btree ("calendar_token");--> statement-breakpoint
CREATE INDEX "conversations_contractor_idx" ON "conversations" USING btree ("contractor_id","created_at");--> statement-breakpoint
CREATE INDEX "conversations_phone_idx" ON "conversations" USING btree ("contractor_id","phone","last_activity_at");--> statement-breakpoint
CREATE UNIQUE INDEX "optouts_pk" ON "optouts" USING btree ("contractor_id","phone");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_paypal_id_idx" ON "payments" USING btree ("paypal_id");--> statement-breakpoint
CREATE INDEX "payments_occurred_idx" ON "payments" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "texts_contractor_idx" ON "texts" USING btree ("contractor_id","created_at");--> statement-breakpoint
CREATE INDEX "texts_conversation_idx" ON "texts" USING btree ("conversation_id","created_at");