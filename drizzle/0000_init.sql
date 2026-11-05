CREATE TABLE "churches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"city" text,
	"pastor_name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"service_times" text NOT NULL,
	"what_to_expect" text NOT NULL,
	"welcome_message" text NOT NULL,
	"trial_ends_at" timestamp with time zone NOT NULL,
	"subscription_status" text,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"current_period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"church_id" uuid NOT NULL,
	"visitor_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"direction" text DEFAULT 'outbound' NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"scheduled_for" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"provider" text,
	"provider_message_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"church_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"phone" text NOT NULL,
	"opted_out" boolean DEFAULT false NOT NULL,
	"returned_at" timestamp with time zone,
	"last_reply_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_church_id_churches_id_fk" FOREIGN KEY ("church_id") REFERENCES "public"."churches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_visitor_id_visitors_id_fk" FOREIGN KEY ("visitor_id") REFERENCES "public"."visitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_church_id_churches_id_fk" FOREIGN KEY ("church_id") REFERENCES "public"."churches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "churches_slug_idx" ON "churches" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "churches_email_idx" ON "churches" USING btree ("email");--> statement-breakpoint
CREATE INDEX "messages_due_idx" ON "messages" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "messages_visitor_idx" ON "messages" USING btree ("visitor_id");--> statement-breakpoint
CREATE INDEX "messages_church_idx" ON "messages" USING btree ("church_id","created_at");--> statement-breakpoint
CREATE INDEX "visitors_church_idx" ON "visitors" USING btree ("church_id","created_at");--> statement-breakpoint
CREATE INDEX "visitors_phone_idx" ON "visitors" USING btree ("phone");