# 03 · Agent Org Setup — Jev · Claude · DeepSeek · Hermes

## Org chart

```
                 Mises (human approver: money, posts, merges to main, deploys)
                        │
                     [ Jev ]  Orchestrator / PM
         ┌──────────────┼──────────────────┬──────────────────────┐
   [Claude Architect]  [Claude Builder]  [DeepSeek Workers]   [Hermes runtime (claw-agent)]
   design + review     core code + tests  bulk code, data,     ├─ PumpWire (seller, $PWIRE agent on ClawPump)
                                          labeling, drafts     └─ PWIRE Scout (buyer/alerts)
```

## Roles

| Agent | Model / runtime | Owns | Never does |
|---|---|---|---|
| **Jev** | Claude (Opus/Sonnet class) as orchestrator | Plan, task board (`TASKS.md`), assigning work, running gates, daily 9 AM + 9 PM CT status to Mises, scope cuts | Writes large code itself; approves its own gates |
| **Claude Architect** | Claude Code on Contabo | Architecture, interfaces, scoring design, security review, final code review on every PR | Merges without Mises |
| **Claude Builder** | Claude Code on Contabo (separate worktree) | x402 API, MCP package, ingest core, deploy scripts, tests | Touches keys or mainnet config |
| **DeepSeek Workers** | DeepSeek chat model (bulk) + DeepSeek reasoner (second opinion), via API or OpenRouter | Parsers, fixtures, labeling ~200 historical launches, docs, X drafts, second-opinion review of scoring logic | Final decisions, prod deploys, anything with secrets |
| **PumpWire (seller)** | Hermes / claw-agent tied to the $PWIRE ClawPump agent | Public face of the product on ClawPump; answers "is this mint risky?" by calling our API; listed as an x402 service | Trades, spends beyond cap |
| **PWIRE Scout (buyer)** | Hermes / claw-agent, own wallet | Watches launches, pays per score, drafts alerts for Mises to approve | Posts without approval; spends > daily cap |

## Model routing (cost-aware)

| Task type | Route to |
|---|---|
| Architecture, security, x402 payment verification, final review | Claude Architect |
| Feature code + tests | Claude Builder |
| Boilerplate, parsers, SQL, fixtures, bulk labeling, docs, social drafts | DeepSeek chat |
| "Is this scoring logic sound / what did we miss?" | DeepSeek reasoner (second opinion) → Claude Architect decides |
| Onchain actions, ClawPump MCP, runtime agent behavior | Hermes (claw-agent) |

## Infra

- **Contabo VPS** (`joseph` user): repo `~/pumpwire`, SQLite at `~/pumpwire/data/pumpwire.db`, services via `pm2`, Caddy TLS.
- **Hermes / claw-agent install** (on VPS):
  ```bash
  curl -fsSL https://raw.githubusercontent.com/Clawpump/claw-agent/main/scripts/install.sh | bash
  hermes setup            # wizard
  hermes model            # pick provider/model (OpenRouter → Claude / DeepSeek)
  hermes clawpump setup   # connect ClawPump MCP (131 tools)
  hermes tools            # enable only what each agent needs
  hermes gateway          # optional: Telegram for Scout alerts
  ```
- **ClawPump Agent MCP** (for Claude Code): `npx @clawpump/agents --claude` with an API key (`cpk_…`) from `clawpump.tech/dashboard/api`. Public Launchpad MCP: `https://clawpump.tech/api/mcp`.
- **ClawPump custom skills:** `create_custom_skill()` / `update_custom_skill()` via Agent MCP to put the PumpWire skill on the $PWIRE agent.
- **Secrets:** `.env` on VPS only (`HELIUS_API_KEY`, `PAYTO_ADDRESS`, `SCOUT_KEYPAIR_PATH`, `CLAWPUMP_API_KEY`, `DEEPSEEK_API_KEY`). `chmod 600`. Never committed, never pasted into chats.

## Repo layout

```
pumpwire/
  AGENTS.md / CLAUDE.md   # points every agent to skills + rules
  TASKS.md                # Jev's board: TODO / DOING / REVIEW / DONE, owner, due
  DECISIONS.md            # ADR-lite log
  packages/
    ingest/   score/   api/   mcp/   live/
  agents/
    scout/  seller/        # Hermes configs + skills
  data/ (gitignored)   scripts/   tests/
```

## Handoff protocol

Every task card in `TASKS.md`:

```
### T-012 rug_risk_score v0
owner: claude-builder · reviewer: claude-architect · due: Thu Oct 1 21:00 CT
inputs: packages/ingest schema, 01-spec §scoring
done when: unit tests pass (≥ 15 cases), backtest script prints precision@HIGH, reasons[] populated
handoff note: <what changed, how to run, known gaps>
```

A worker finishes → writes the handoff note → Jev moves the card to REVIEW → reviewer approves or bounces with concrete fixes.

## Gates (Jev enforces, Mises approves)

| Gate | Pass criteria | Approver |
|---|---|---|
| G1 Ingest | ≥ 1h of launches + trades stored, no crashes, < 5s lag | Jev |
| G2 Score | tests green; backtest reported; reasons readable | Claude Architect |
| G3 Devnet paid | 20 successful paid calls on devnet via MCP client; bad payment rejected; replay rejected | Claude Architect |
| G4 Mainnet | Mises approves `payTo`, prices, caps; 3 real paid calls verified on Solscan | **Mises** |
| G5 Public | /live shows first-party vs third-party split; README + integrate snippet | **Mises** |

## Spending caps

| Agent | Per call | Per day | Needs Mises |
|---|---|---|---|
| Scout | ≤ $0.05 | ≤ $5 | anything above |
| Seller | $0 (receives only) | — | any outgoing tx |
| Builders | none (no keys) | — | — |

## Cadence

- **9:00 AM CT:** Jev posts the plan for the day (≤ 10 lines) + blockers needing Mises.
- **9:00 PM CT:** Jev posts done/not done vs deadline, metrics (calls, USDC, $ANSEM, integrators), tomorrow's top 3.
- **Scope rule:** if the Sat Oct 3 mainnet deadline is at risk, Jev cuts stretch features, never the paid-call loop.
