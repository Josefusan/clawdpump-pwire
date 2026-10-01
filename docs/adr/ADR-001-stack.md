# ADR-001: Stack for the 24h build
Status: accepted (T-002) · Context: 01 §Architecture, 03 §Infra, D-001

**Decision**
- Node.js + TypeScript (ESM) monorepo, `packages/{ingest,score,api,mcp,live,scout}` (INTERFACES §1).
- SQLite in WAL mode via `better-sqlite3` (sync, prepared statements); schema = `docs/schema.sql`.
  DB at `~/pumpwire-data/pumpwire.db`, hourly `snapshot.db` (D-001); ingest and api each write only their own tables.
- HTTP: `express` + `@x402/express` / `@x402/core` / `@x402/svm` (x402 V2, `exact` scheme) — package names VERIFY.
- MCP: `pumpwire-mcp` over stdio + streamable HTTP, paying with `@x402/fetch` + `@x402/svm` — package names VERIFY.
- Tests: `vitest`; scoring is a pure function tested from fixtures (INTERFACES §5.4).
- Ops: `pm2` process manager, Caddy for TLS on the Contabo VPS; secrets in `~/.config/pumpwire/*.env`.

**Why**: boring, single-box, no external DB; synchronous SQLite keeps score snapshots consistent.
WAL allows one writer per process with concurrent readers (api reads while ingest writes).

**Consequences**: one host is the ceiling; `SQLITE_BUSY` handled with `busy_timeout=5000`.
Package versions are unpinned here — builders pin on install (VERIFY versions / V2 API surface).
Postgres, queues and a UI framework are out of scope for this sprint.
