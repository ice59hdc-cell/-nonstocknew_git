-- Neon/PostgreSQL schema. Apply before running the SQLite data migration.
CREATE TABLE IF NOT EXISTS units (
  unit_id text PRIMARY KEY,
  unit_name text NOT NULL,
  district text NOT NULL,
  affiliation text,
  active text NOT NULL DEFAULT 'Y',
  note text
);

CREATE TABLE IF NOT EXISTS transactions (
  txn_id text PRIMARY KEY,
  unit_id text NOT NULL REFERENCES units(unit_id),
  fiscal_year integer NOT NULL,
  month_no integer NOT NULL CHECK (month_no BETWEEN 1 AND 12),
  calendar_year integer,
  month_name text,
  "disbursed_A" double precision,
  "stock_B" double precision,
  "reserve_C" double precision,
  source text,
  note text,
  recorded_at timestamp without time zone,
  updated_at timestamp without time zone
);
CREATE INDEX IF NOT EXISTS ix_transactions_fy_month ON transactions(fiscal_year, month_no);
CREATE INDEX IF NOT EXISTS ix_transactions_unit ON transactions(unit_id);

CREATE TABLE IF NOT EXISTS insights (
  id text PRIMARY KEY,
  title text NOT NULL,
  source text,
  insight text,
  action text,
  priority text,
  status text,
  created_at timestamp without time zone,
  updated_at timestamp without time zone
);

CREATE TABLE IF NOT EXISTS lessons (
  id text PRIMARY KEY,
  unit_id text,
  fiscal_year integer,
  month_no integer CHECK (month_no IS NULL OR month_no BETWEEN 1 AND 12),
  problem text NOT NULL,
  obstacle text,
  solution text,
  status text,
  created_at timestamp without time zone,
  updated_at timestamp without time zone
);

CREATE TABLE IF NOT EXISTS master_prompts (
  id text PRIMARY KEY,
  title text NOT NULL,
  category text,
  purpose text,
  prompt text NOT NULL,
  tags text,
  status text,
  created_at timestamp without time zone,
  updated_at timestamp without time zone
);

CREATE TABLE IF NOT EXISTS kpi_targets (
  fiscal_year integer PRIMARY KEY,
  green_min double precision,
  green_max double precision,
  warn_low double precision,
  warn_high double precision,
  note text
);

CREATE TABLE IF NOT EXISTS users (
  username text PRIMARY KEY,
  pass_hash text NOT NULL,
  salt text NOT NULL,
  role text NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'viewer'))
);

-- Only SHA-256 token digests are stored; a database leak cannot replay a session.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  username text NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_sessions_expiry ON sessions(expires_at);

-- Service-unit accounts: role 'unit' is tied to one unit. Safe to re-run on an existing database.
ALTER TABLE users ADD COLUMN IF NOT EXISTS unit_id text REFERENCES units(unit_id);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'viewer', 'unit'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_unit_role_check;
ALTER TABLE users ADD CONSTRAINT users_unit_role_check CHECK (role <> 'unit' OR unit_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS ix_users_unit ON users(unit_id);
