import {
  pgTable,
  text,
  timestamp,
  uuid,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const churches = pgTable(
  "churches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    city: text("city"),
    pastorName: text("pastor_name").notNull(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    serviceTimes: text("service_times").notNull(),
    whatToExpect: text("what_to_expect").notNull(),
    welcomeMessage: text("welcome_message").notNull(),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }).notNull(),
    // Our normalized subscription status: active | past_due | canceled (null = never subscribed).
    subscriptionStatus: text("subscription_status"),
    paypalSubscriptionId: text("paypal_subscription_id"),
    // Paid-through date (PayPal's next billing time). A canceled church stays active until then.
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    // Last time the pastor opened their dashboard (updated at most hourly).
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("churches_slug_idx").on(t.slug),
    uniqueIndex("churches_email_idx").on(t.email),
  ],
);

export const visitors = pgTable(
  "visitors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    churchId: uuid("church_id")
      .notNull()
      .references(() => churches.id, { onDelete: "cascade" }),
    firstName: text("first_name").notNull(),
    phone: text("phone").notNull(), // E.164, e.g. +15555550123
    optedOut: boolean("opted_out").notNull().default(false),
    returnedAt: timestamp("returned_at", { withTimezone: true }),
    lastReplyAt: timestamp("last_reply_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("visitors_church_idx").on(t.churchId, t.createdAt),
    index("visitors_phone_idx").on(t.phone),
  ],
);

/**
 * Every text, outbound and inbound.
 * kind:      welcome | checkin | invite | reply (inbound)
 * direction: outbound | inbound
 * status:    scheduled | sending | sent | failed | skipped | received
 */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    churchId: uuid("church_id")
      .notNull()
      .references(() => churches.id, { onDelete: "cascade" }),
    visitorId: uuid("visitor_id")
      .notNull()
      .references(() => visitors.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    direction: text("direction").notNull().default("outbound"),
    body: text("body").notNull(),
    status: text("status").notNull().default("scheduled"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    provider: text("provider"),
    providerMessageId: text("provider_message_id"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("messages_due_idx").on(t.status, t.scheduledFor),
    index("messages_visitor_idx").on(t.visitorId),
    index("messages_church_idx").on(t.churchId, t.createdAt),
  ],
);

export type Church = typeof churches.$inferSelect;
export type Visitor = typeof visitors.$inferSelect;
export type Message = typeof messages.$inferSelect;
