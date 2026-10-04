---
name: simplified-technical-english
description: Write and rewrite technical text in Simplified Technical English (ASD-STE100) — clear, short, easy-to-translate documentation. Use for docs, READMEs, procedures, error messages and release notes, and to check a draft against STE rules.
---

# Simplified Technical English (STE)

Third-party skill, tracked as a submodule at `integrations/simplified-technical-english/`
(`0xpili/simplified-technical-english`, MIT). The ASD-STE100 word list stays the property of ASD —
read its `NOTICE.md` before you use or redistribute the list.

## Load it

1. After cloning, initialize the submodule: `git submodule update --init integrations/simplified-technical-english`.
2. Read `integrations/simplified-technical-english/SKILL.md` for the primary rules.
3. When a rule is unclear or you rewrite a whole document, read `references/writing-rules.md`.
4. Approved words are in `references/word-list.md`. Replacements are in `references/substitutions.md`.
5. If you can run Python 3, check a draft:
   `python3 integrations/simplified-technical-english/scripts/ste_check.py --mode <procedural|descriptive> <file>`.

## Where PumpWire uses it

- Public docs: `README.md`, `docs/SUBMISSION.md`, `docs/USE-CASES.md`, `hermes/README.md`, `examples/`.
- User-facing strings: API error bodies, `/live` copy, alert drafts.
- Do not apply STE to code, identifiers, commands, file paths, or quoted error messages.

## Guardrails

- A human approves every public post. See `clawrena-compliance`.
- STE is a style layer only: never change a price, address, mint, transaction signature or number.
- If `clawrena-compliance` and this skill disagree on wording, `clawrena-compliance` wins.
