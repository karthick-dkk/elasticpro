-- ElasticPro — shared state that must outlive one browser.
-- Accounts are owned by the core, in users.json beside pins.json — see crates/elasticpro-core/
-- src/auth.rs. This table is the reporting copy: it exists so acks, notes and audit rows
-- can reference a name, not so the core can look one up. The role vocabulary is the
-- core's, and 'operator'/'viewer' are the names this file used while accounts were still
-- a plan; Role::parse still accepts both so an early row resolves.
CREATE TABLE IF NOT EXISTS users (
  name        text PRIMARY KEY,
  role        text NOT NULL DEFAULT 'user'
              CHECK (role IN ('admin', 'user', 'guest', 'operator', 'viewer')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Acknowledgements and notes, keyed by the alert's stable key (<cluster>:<kind>[:detail]).
CREATE TABLE IF NOT EXISTS acks (
  key         text PRIMARY KEY,
  acked       boolean NOT NULL DEFAULT false,
  acked_by    text,
  acked_at    timestamptz
);
CREATE TABLE IF NOT EXISTS notes (
  id          bigserial PRIMARY KEY,
  key         text NOT NULL REFERENCES acks(key) ON DELETE CASCADE,
  author      text NOT NULL,
  text        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notes_key ON notes(key);

-- Every write the core performed, by whom. Mirrors the core's audit log line.
CREATE TABLE IF NOT EXISTS audit (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  "user"      text NOT NULL,
  msg_type    text NOT NULL,
  cluster     text,
  method      text,
  path        text,
  ok          boolean,
  kind        text
);
CREATE INDEX IF NOT EXISTS audit_at ON audit(at DESC);
