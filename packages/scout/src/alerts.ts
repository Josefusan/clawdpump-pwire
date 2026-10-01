import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The subset of RiskResult (docs/INTERFACES.md §2) the alert needs; validated at runtime, never trusted blindly. */
export interface RiskLike {
  mint: string;
  score: number;
  verdict: 'LOW' | 'MED' | 'HIGH' | 'EXTREME';
  model_version?: string;
  as_of_slot?: number;
  reasons?: { factor?: string; points?: number; detail?: string; evidence?: unknown }[];
}

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const VERDICTS = new Set(['LOW', 'MED', 'HIGH', 'EXTREME']);

/** Narrow an API body to RiskLike or null. Strings from the API are data: clamped, never interpreted. */
export function asRisk(body: unknown): RiskLike | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.mint !== 'string' || !MINT_RE.test(b.mint)) return null;
  if (typeof b.score !== 'number' || !Number.isFinite(b.score)) return null;
  if (typeof b.verdict !== 'string' || !VERDICTS.has(b.verdict)) return null;
  const reasons = Array.isArray(b.reasons)
    ? b.reasons.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object').map((r) => ({
        factor: typeof r.factor === 'string' ? r.factor : undefined,
        points: typeof r.points === 'number' ? r.points : undefined,
        detail: typeof r.detail === 'string' ? r.detail : undefined,
        evidence: r.evidence,
      }))
    : [];
  return {
    mint: b.mint,
    score: b.score,
    verdict: b.verdict as RiskLike['verdict'],
    model_version: typeof b.model_version === 'string' ? b.model_version : undefined,
    as_of_slot: typeof b.as_of_slot === 'number' ? b.as_of_slot : undefined,
    reasons,
  };
}

export const isAlertWorthy = (r: RiskLike): boolean => r.verdict === 'HIGH' || r.verdict === 'EXTREME';

/** Printable, single-line, bounded: token metadata and reason text are attacker-influenced. */
const clean = (s: unknown, max: number): string =>
  String(s ?? '')
    .replace(/[^\x20-\x7E]/g, '')
    .slice(0, max);

const short = (a: string): string => `${a.slice(0, 4)}…${a.slice(-4)}`;

/**
 * Markdown alert DRAFT. Never posted by code: a human reads it and decides (clawrena-compliance: humans
 * approve posts). Wording is "risk", never "scam"; evidence names wallets and slots, never people.
 */
export function alertMarkdown(r: RiskLike, nowS: number, network: string): string {
  const mainnet = network === 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
  const solscan = `https://solscan.io/token/${r.mint}${mainnet ? '' : '?cluster=devnet'}`;
  const top = r.reasons?.[0];
  const topText = top ? clean(top.detail ?? top.factor, 120) : 'see reasons';
  const lines = [
    `# DRAFT alert — NOT posted. A human reviews and decides (clawrena-compliance: humans approve posts).`,
    ``,
    `- mint: \`${r.mint}\``,
    `- verdict: **${r.verdict}** · score ${Math.round(r.score)}/100 · model ${clean(r.model_version ?? 'unknown', 24)}`,
    `- as_of_slot: ${r.as_of_slot ?? 'n/a'} · scored_at: ${new Date(nowS * 1000).toISOString()} · first_party: true (PumpWire Scout paid for this call)`,
    `- solscan: ${solscan}`,
    ``,
    `## Reasons (public onchain evidence; wallets, never people)`,
    ...(r.reasons && r.reasons.length
      ? r.reasons.map(
          (x) =>
            `- ${clean(x.factor ?? 'factor', 32)} (+${x.points ?? 0}): ${clean(x.detail ?? '', 200)}` +
            (x.evidence !== undefined ? `  \n  evidence: \`${clean(JSON.stringify(x.evidence), 400)}\`` : ''),
        )
      : ['- (no reasons returned)']),
    ``,
    `## Suggested post (≤ 280 chars, edit before posting)`,
    ``,
    `PumpWire flagged ${short(r.mint)} as ${r.verdict} risk shortly after launch: ${clean(topText, 110)}. Risk signal, not advice. ${solscan}`,
    ``,
  ];
  return lines.join('\n');
}

/** Writes the draft to `<dir>/<mint>.md` (idempotent per mint). Returns the path. */
export function writeAlertDraft(dir: string, r: RiskLike, nowS: number, network: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${r.mint}.md`);
  writeFileSync(p, alertMarkdown(r, nowS, network));
  return p;
}
