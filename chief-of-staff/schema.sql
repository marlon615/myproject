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
