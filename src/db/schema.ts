import {
  pgTable,
  text,
  timestamp,
  uuid,
  boolean,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** One HVAC business (a signup). */
export const contractors = pgTable(
  "contractors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessName: text("business_name").notNull(),
    ownerName: text("owner_name").notNull(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    /** The contractor's existing business line (the one customers already call). E.164. */
    businessPhone: text("business_phone").notNull(),
    /** Where emergency alerts and new-booking texts go (owner or on-call tech). E.164. */
    alertPhone: text("alert_phone").notNull(),
    /** The CallCairn line (a Twilio number) that missed/after-hours calls forward to. E.164. */
    aiNumber: text("ai_number"),
    twilioNumberSid: text("twilio_number_sid"),
    serviceArea: text("service_area"),
    /** IANA zone the business works in, e.g. America/Chicago. */
    timezone: text("timezone").notNull().default("America/Chicago"),
    /** Business hours, local time, whole hours 0–24. */
    hoursStart: integer("hours_start").notNull().default(8),
    hoursEnd: integer("hours_end").notNull().default(17),
    /** Working weekdays, 0 = Sunday … 6 = Saturday, comma separated. */
    workDays: text("work_days").notNull().default("1,2,3,4,5"),
    /** Length of each arrival window offered to callers. */
    slotMinutes: integer("slot_minutes").notNull().default(120),
    /** How many jobs can be booked into the same window. */
    jobsPerSlot: integer("jobs_per_slot").notNull().default(1),
    /** Offer an ASAP visit to emergencies outside business hours. */
    emergencyDispatch: boolean("emergency_dispatch").notNull().default(true),
    /** Optional, read to emergency callers, e.g. "There is a $149 after-hours dispatch fee." */
    emergencyNote: text("emergency_note"),
    /** Secret for the read-only calendar feed (.ics). */
    calendarToken: text("calendar_token").notNull(),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }).notNull(),
    /** active | past_due | canceled (null = never subscribed). */
    subscriptionStatus: text("subscription_status"),
    paypalSubscriptionId: text("paypal_subscription_id"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("contractors_email_idx").on(t.email),
    uniqueIndex("contractors_ai_number_idx").on(t.aiNumber),
    uniqueIndex("contractors_calendar_token_idx").on(t.calendarToken),
  ],
);

export type Slot = { start: string; end: string };

/**
 * One customer interaction (a lead), across a call and any texts that follow.
 * step:    what the assistant is waiting for (issue | name | address | time | pick | done)
 * urgency: unknown | emergency | routine
 * status:  open | booked | handoff (team must call back) | closed
 */
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractorId: uuid("contractor_id").notNull().references(() => contractors.id, { onDelete: "cascade" }),
    phone: text("phone").notNull(),
    channel: text("channel").notNull(), // voice | sms (where it started)
    step: text("step").notNull().default("issue"),
    urgency: text("urgency").notNull().default("unknown"),
    hazard: text("hazard"), // gas | co | fire | electrical (life-safety)
    customerName: text("customer_name"),
    address: text("address"),
    issue: text("issue"),
    timePref: text("time_pref"),
    offeredSlots: jsonb("offered_slots").$type<Slot[]>(),
    offerRound: integer("offer_round").notNull().default(0),
    status: text("status").notNull().default("open"),
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("conversations_contractor_idx").on(t.contractorId, t.createdAt),
    index("conversations_phone_idx").on(t.contractorId, t.phone, t.lastActivityAt),
  ],
);

export type TranscriptLine = { role: "assistant" | "caller"; text: string; at: string };

/**
 * Every call the AI line receives.
 * outcome: booked | emergency | safety | handoff | texted_back | hung_up | inactive
 */
export const calls = pgTable(
  "calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractorId: uuid("contractor_id").notNull().references(() => contractors.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    callSid: text("call_sid").notNull(),
    fromPhone: text("from_phone").notNull(),
    toPhone: text("to_phone").notNull(),
    /** Twilio's ForwardedFrom: the contractor line the call was forwarded from, when known. */
    forwardedFrom: text("forwarded_from"),
    status: text("status").notNull().default("in-progress"),
    outcome: text("outcome"),
    durationSec: integer("duration_sec"),
    transcript: jsonb("transcript").$type<TranscriptLine[]>().notNull().default([]),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("calls_sid_idx").on(t.callSid),
    index("calls_contractor_idx").on(t.contractorId, t.startedAt),
  ],
);

/**
 * Every text, in and out.
 * kind:   textback | assistant | confirmation | reminder | alert (to the contractor) | reply (inbound) | optout | optin
 * status: sending | sent | failed | skipped | received
 */
export const texts = pgTable(
  "texts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractorId: uuid("contractor_id").notNull().references(() => contractors.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    direction: text("direction").notNull(), // outbound | inbound
    phone: text("phone").notNull(), // the other party
    kind: text("kind").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull(),
    provider: text("provider"),
    providerMessageId: text("provider_message_id"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("texts_contractor_idx").on(t.contractorId, t.createdAt),
    index("texts_conversation_idx").on(t.conversationId, t.createdAt),
  ],
);

/** Jobs on the contractor's calendar. status: booked | canceled */
export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractorId: uuid("contractor_id").notNull().references(() => contractors.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    customerName: text("customer_name").notNull(),
    phone: text("phone").notNull(),
    address: text("address").notNull(),
    issue: text("issue").notNull(),
    urgency: text("urgency").notNull(),
    source: text("source").notNull(), // voice | sms
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("booked"),
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("bookings_contractor_idx").on(t.contractorId, t.startsAt),
    index("bookings_created_idx").on(t.createdAt),
  ],
);

/**
 * Every PayPal money movement we hear about.
 * status: completed | refunded | reversed | failed
 */
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractorId: uuid("contractor_id").references(() => contractors.id, { onDelete: "set null" }),
    /** PayPal's sale/refund id, or the webhook event id for failed payments. */
    paypalId: text("paypal_id").notNull(),
    subscriptionId: text("subscription_id"),
    eventType: text("event_type").notNull(),
    status: text("status").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payments_paypal_id_idx").on(t.paypalId),
    index("payments_occurred_idx").on(t.occurredAt),
  ],
);

/** Phones that texted STOP to a contractor's line. */
export const optouts = pgTable(
  "optouts",
  {
    contractorId: uuid("contractor_id").notNull().references(() => contractors.id, { onDelete: "cascade" }),
    phone: text("phone").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("optouts_pk").on(t.contractorId, t.phone)],
);

export type Contractor = typeof contractors.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Call = typeof calls.$inferSelect;
export type Text = typeof texts.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type Payment = typeof payments.$inferSelect;
