# agent-org — PumpWire 24h sprint control plane

Everything the Principal agent (Command Code, DeepSeek) needs to run the PumpWire build org:
Principal prompt, Jev decision layer, memory system, guard hook, dispatch scripts, VPS runner, worker roles, seeded task board.

| File | What |
|---|---|
| `PRINCIPAL.md` | Principal system prompt (installed as `~/pumpwire-control/AGENTS.md`) |
| `ARCHITECTURE.md` | Org design: topology, roster + rules, memory, Jev, token rules, safety, timeline, setup |
| `pumpwire-control.zip` | The full control dir (`.commandcode/`, `bin/`, `scripts/jev.mjs`, `.org/`, `vps/`), exec bits preserved |

## Install (Mac, from a clone of this repo)
```bash
unzip -o agent-org/pumpwire-control.zip -d ~          # → ~/pumpwire-control
cd ~/pumpwire-control && cp -n .env.example .env       # add AI_GATEWAY_API_KEY
chmod +x bin/* .commandcode/hooks/guard.sh
git init -q 2>/dev/null; git add -A && git commit -qm "control plane" || true
git clone git@github.com:Josefusan/clawdpump-pwire.git repo 2>/dev/null || true
bin/pw-sync-vps && bin/pw-doctor
```
Then `cmd` in `~/pumpwire-control` → "Start the sprint. Follow AGENTS.md §12."

No secrets live here. Secrets stay in `~/pumpwire-control/.env` (Mac) and `~/.config/pumpwire/*.env` (VPS).
