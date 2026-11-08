-- Chief of Staff database (Cloudflare D1 / SQLite). Safe to run more than once.

create table if not exists prospects (
  id integer primary key autoincrement,
  product text not null check (product in ('clientpulse', 'churchfollow')),
  name text not null default '',
  email text not null,
  organization text not null default '',
  notes text not null default '',
  status text not null default 'new' check (status in ('new', 'contacted', 'replied', 'not_interested', 'do_not_contact')),
  touches integer not null default 0,
  last_sent_at text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  unique (product, email)
);
create index if not exists prospects_status on prospects (status, last_sent_at);

create table if not exists drafts (
  id integer primary key autoincrement,
  prospect_id integer not null references prospects(id) on delete cascade,
  product text not null,
  touch integer not null default 1,
  subject text not null,
  body text not null,
  source text not null default 'template' check (source in ('ai', 'template')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'sent', 'failed')),
  error text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  decided_at text,
  sent_at text
);
create index if not exists drafts_status on drafts (status, created_at);
create index if not exists drafts_prospect on drafts (prospect_id);

create table if not exists settings (
  key text primary key,
  value text not null
);

create table if not exists login_attempts (
  ip text not null,
  at integer not null
);
create index if not exists login_attempts_ip on login_attempts (ip, at);

create table if not exists runs (
  id integer primary key autoincrement,
  at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  trigger text not null,
  created integer not null default 0,
  note text
);

-- Gmail messages Chief has seen (summaries only, plus what's needed to reply in the same thread).
create table if not exists inbox (
  id integer primary key autoincrement,
  message_id text not null unique,
  uid integer,
  from_name text not null default '',
  from_email text not null,
  subject text not null default '',
  received_at text,
  summary text not null default '',
  priority text not null default 'normal',
  needs_reply integer not null default 0,
  refs text not null default '',
  status text not null default 'new' check (status in ('new', 'heard', 'replied', 'dismissed')),
  source text not null default 'template',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create index if not exists inbox_status on inbox (status, received_at);

-- Reply drafts waiting for a yes or no.
create table if not exists replies (
  id integer primary key autoincrement,
  inbox_id integer not null references inbox(id) on delete cascade,
  to_email text not null,
  to_name text not null default '',
  subject text not null,
  body text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'sent', 'failed')),
  error text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  decided_at text,
  sent_at text
);
create index if not exists replies_status on replies (status, created_at);

-- Things Chief remembers for you ("remember to call Pastor Dave").
create table if not exists todos (
  id integer primary key autoincrement,
  text text not null,
  status text not null default 'open' check (status in ('open', 'done')),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  done_at text
);
create index if not exists todos_status on todos (status, created_at)
;

-- People Chief knows, gathered from Gmail (and numbers you tell it). No typing needed.
create table if not exists contacts (
  id integer primary key autoincrement,
  name text not null default '',
  email text unique,
  phone text,
  source text not null default 'gmail',
  last_seen_at text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create index if not exists contacts_name on contacts (name);

-- One-off emails you dictate to anyone ("email Dave saying ..."), waiting for your yes.
create table if not exists outbox (
  id integer primary key autoincrement,
  to_email text not null,
  to_name text not null default '',
  subject text not null,
  body text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'sent', 'failed')),
  error text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  decided_at text,
  sent_at text
)
;

-- Phones that get notifications (Web Push subscriptions).
create table if not exists push_subs (
  id integer primary key autoincrement,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One-tap approvals sent in notifications. Only a hash of the token is stored.
create table if not exists approvals (
  id integer primary key autoincrement,
  token_hash text not null unique,
  kind text not null, -- reply | outreach_batch | fyi | brief
  ref text not null,
  title text not null default '',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at text not null,
  used_at text
)
