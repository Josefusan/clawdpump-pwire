-- PumpWire SQLite schema (T-002, frozen). Canonical; applied by packages/ingest on startup.
-- DB path: $PUMPWIRE_DB_PATH (D-001: ~/pumpwire-data/pumpwire.db). Types: docs/INTERFACES.md §2.
-- Units: times = unix seconds; SOL = lamports; token amounts = raw base units. Booleans = 0/1.
-- journal_mode=WAL persists in the file; synchronous/busy_timeout are per-connection and every
-- process (ingest, api, snapshot job) must set them on open.
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS tokens (
  mint          TEXT PRIMARY KEY,
  name          TEXT,                 -- attacker-controlled, clamped to 64 chars
  symbol        TEXT,                 -- attacker-controlled, clamped to 16 chars
  uri           TEXT,                 -- attacker-controlled, clamped to 200 chars
  deployer      TEXT NOT NULL,
  created_slot  INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  curve_pct     REAL CHECK (curve_pct IS NULL OR (curve_pct >= 0 AND curve_pct <= 100)),
  migrated      INTEGER NOT NULL DEFAULT 0 CHECK (migrated IN (0, 1)),
  has_socials   INTEGER CHECK (has_socials IS NULL OR has_socials IN (0, 1)),
  outcome       TEXT CHECK (outcome IS NULL OR outcome IN ('DEAD_1H', 'DEV_DUMP', 'SURVIVED_24H')),
  outcome_at    INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS idx_tokens_deployer ON tokens (deployer, created_at);
CREATE INDEX IF NOT EXISTS idx_tokens_created  ON tokens (created_at);

CREATE TABLE IF NOT EXISTS trades (
  sig           TEXT PRIMARY KEY,     -- idempotent insert: INSERT OR IGNORE
  mint          TEXT NOT NULL,
  wallet        TEXT NOT NULL,
  side          TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  lamports      INTEGER NOT NULL CHECK (lamports >= 0),
  token_amount  INTEGER NOT NULL CHECK (token_amount >= 0),
  slot          INTEGER NOT NULL,
  ts            INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_trades_mint_slot ON trades (mint, slot, sig);
CREATE INDEX IF NOT EXISTS idx_trades_wallet    ON trades (wallet);
CREATE INDEX IF NOT EXISTS idx_trades_ts        ON trades (ts);

CREATE TABLE IF NOT EXISTS wallets (
  address       TEXT PRIMARY KEY,
  first_seen_ts INTEGER,
  tx_count      INTEGER CHECK (tx_count IS NULL OR tx_count >= 0),
  funder        TEXT,
  funder_ts     INTEGER,
  enriched_at   INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS idx_wallets_funder ON wallets (funder);

CREATE TABLE IF NOT EXISTS deployers (
  address        TEXT PRIMARY KEY,
  launches       INTEGER NOT NULL DEFAULT 0,
  dead_1h        INTEGER NOT NULL DEFAULT 0,
  dev_dumped     INTEGER NOT NULL DEFAULT 0,
  last_launch_ts INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS funding_edges (
  src      TEXT NOT NULL,
  dst      TEXT NOT NULL,
  lamports INTEGER NOT NULL CHECK (lamports >= 0),
  ts       INTEGER NOT NULL,
  sig      TEXT NOT NULL,
  PRIMARY KEY (sig, src, dst)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_funding_dst ON funding_edges (dst, ts);
CREATE INDEX IF NOT EXISTS idx_funding_src ON funding_edges (src, ts);

-- Written only by packages/api. Replay protection = UNIQUE payment_id (claimed before serving)
-- + UNIQUE tx_sig (after settlement). See ADR-002.
CREATE TABLE IF NOT EXISTS calls (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                INTEGER NOT NULL,
  tool              TEXT NOT NULL CHECK (tool IN ('rug_risk_score', 'deployer_history', 'early_buyer_map', 'deployer_alerts')),
  arg               TEXT NOT NULL,
  payer             TEXT,
  network           TEXT NOT NULL,
  asset             TEXT NOT NULL,
  amount            INTEGER NOT NULL CHECK (amount > 0),
  payment_id        TEXT NOT NULL UNIQUE,
  tx_sig            TEXT UNIQUE,
  settle_via        TEXT NOT NULL CHECK (settle_via IN ('facilitator', 'direct')),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'served', 'failed')),
  score             INTEGER CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  verdict           TEXT CHECK (verdict IS NULL OR verdict IN ('LOW', 'MED', 'HIGH', 'EXTREME')),
  result_json       TEXT,
  latency_ms        INTEGER,
  first_party       INTEGER NOT NULL CHECK (first_party IN (0, 1)),
  onchain_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (onchain_confirmed IN (0, 1))
) STRICT;
CREATE INDEX IF NOT EXISTS idx_calls_ts          ON calls (ts);
CREATE INDEX IF NOT EXISTS idx_calls_payer       ON calls (payer, ts);
CREATE INDEX IF NOT EXISTS idx_calls_status_fp   ON calls (status, first_party);
CREATE INDEX IF NOT EXISTS idx_calls_tool_arg    ON calls (tool, arg);
