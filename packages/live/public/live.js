// PumpWire /live — browser renderer for GET /v1/stats (STATS/INTERFACES §4.3).
// No framework, no build step, no secrets. Plain static JS loaded by index.html as a module.
//
// SECURITY (INTERFACES §8): every dynamic string — including attacker-controlled token metadata
// (name / symbol / description, see fixtures/pumpportal/create-injection-*.json) — reaches the DOM
// through `textContent` / `createTextNode` only. This module never assigns innerHTML/outerHTML,
// never calls insertAdjacentHTML/document.write/eval, and only ever builds an href from a value
// that passed the base58 charset+length check. Links to Solscan are therefore the only URLs.

export const STATS_URL = '/v1/stats';

/** Solscan cluster query per CAIP-2 network id; unknown networks fall back to no query. */
export const SOLSCAN_CLUSTER = {
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': '',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': '?cluster=devnet',
  'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z': '?cluster=testnet',
};

const PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TXSIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
// C0/C1 controls plus bidi/format controls: strip them so text cannot spoof or reorder the page.
const FORMAT_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;
const VERDICTS = ['LOW', 'MED', 'HIGH', 'EXTREME'];

export const LIMITS = { generic: 96, symbol: 16, name: 64, description: 160 };

/** Strip control/format chars, collapse whitespace, clamp. Applied to EVERY dynamic string. */
export function safeText(value, max = LIMITS.generic) {
  const s = value === null || value === undefined ? '' : String(value);
  return s.replace(FORMAT_CHARS, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export const isPubkey = (v) => typeof v === 'string' && PUBKEY.test(v);
export const isTxSig = (v) => typeof v === 'string' && TXSIG.test(v);

export function shortAddr(value) {
  const s = safeText(value, 90);
  return s.length > 13 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

function clusterQuery(network) {
  return SOLSCAN_CLUSTER[network] ?? '';
}

/** https://solscan.io/tx/<sig>?cluster=devnet — null when sig is not base58 (never a partial URL). */
export function solscanTx(sig, network) {
  return isTxSig(sig) ? `https://solscan.io/tx/${sig}${clusterQuery(network)}` : null;
}

/** pump.fun mints live on mainnet even while payments settle on devnet, so mint links never carry a cluster. */
export function solscanMint(addr) {
  return isPubkey(addr) ? `https://solscan.io/token/${addr}` : null;
}

/** https://solscan.io/account/<pubkey>?cluster=devnet — null when addr is not base58. */
export function solscanAccount(addr, network) {
  return isPubkey(addr) ? `https://solscan.io/account/${addr}${clusterQuery(network)}` : null;
}

/** Decimal string in UI units → "1,234.5 USDC". Unparseable input degrades to "0 <symbol>". */
export function fmtAmount(decimal, symbol) {
  const n = Number(safeText(decimal, 32));
  if (!Number.isFinite(n)) return `0 ${symbol}`;
  return `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${symbol}`;
}

export function fmtPct(x) {
  return Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : '—';
}

export function fmtAgo(ts, now = Math.floor(Date.now() / 1000)) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '—';
  const d = Math.max(0, now - t);
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

const NETWORKS = {
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'Solana mainnet',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'Solana devnet',
  'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z': 'Solana testnet',
};

export function networkLabel(network) {
  return NETWORKS[network] ?? (safeText(network, 48) || 'unknown network');
}

export function verdictClass(verdict) {
  const v = safeText(verdict, 8).toUpperCase();
  return VERDICTS.includes(v) ? `v-${v.toLowerCase()}` : 'v-none';
}

// null/undefined/'' are "unknown", never 0: Number(null) is 0, which would print a false 0%.
const num = (v, fallback = 0) => (v === null || v === undefined || v === '' ? fallback : Number.isFinite(Number(v)) ? Number(v) : fallback);
const int = (v) => Math.max(0, Math.trunc(num(v, 0)));
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const rows = (v) => (Array.isArray(v) ? v : []);

/** Token metadata is attacker-controlled; keep only clamped plain text (never markup, never a URL). */
function metadataOf(row) {
  return {
    symbol: safeText(row.symbol, LIMITS.symbol),
    name: safeText(row.name, LIMITS.name),
    description: safeText(row.description, LIMITS.description),
  };
}

/** StatsResponse (INTERFACES §4.3) → plain strings + at most two Solscan URLs per row. */
export function buildViewModel(stats, now) {
  const s = obj(stats) ?? {};
  const t = obj(s.totals) ?? {};
  const network = safeText(s.network, 64);
  const paid = int(t.paid_calls);
  const firstParty = int(t.paid_calls_first_party);
  const thirdParty = int(t.paid_calls_third_party);
  const unattributed = int(t.paid_calls_unattributed);
  const backtest = obj(s.backtest);
  const n = int(backtest?.n);

  return {
    network,
    networkLabel: networkLabel(network),
    modelVersion: safeText(s.model_version, 24) || '—',
    generatedAgo: fmtAgo(s.generated_at, now),
    counters: [
      { label: 'paid calls', value: String(paid) },
      { label: 'USDC paid', value: fmtAmount(t.usdc_paid ?? '0', 'USDC') },
      { label: '$ANSEM paid', value: fmtAmount(t.ansem_paid ?? '0', 'ANSEM') },
      { label: '$PWIRE holder calls', value: String(int(t.paid_calls_holder)) },
      { label: 'unique payers', value: String(int(t.unique_payers)) },
      { label: 'third-party wallets', value: String(int(t.unique_integrators)) },
    ],
    split: {
      firstParty,
      thirdParty,
      unattributed,
      firstPartyPct: paid > 0 ? firstParty / paid : 0,
      text:
        `${firstParty} first-party (our Scout) · ${thirdParty} third-party (distinct external wallets, not verified builders)` +
        (unattributed > 0 ? ` · ${unattributed} unattributed (payer not reported)` : '') +
        (paid > 0 ? ` · ${fmtPct(firstParty / paid)} first-party` : ''),
    },
    calls: rows(s.last_calls)
      .slice(0, 50)
      .map((row) => {
        const c = obj(row) ?? {};
        const meta = metadataOf(c);
        const verdict = safeText(c.verdict, 8).toUpperCase();
        return {
          ago: fmtAgo(c.ts, now),
          tool: safeText(c.tool, 24) || '—',
          symbol: meta.symbol || null,
          name: meta.name || null,
          description: meta.description || null,
          mint: shortAddr(c.arg),
          mintHref: solscanMint(c.arg),
          score: c.score === null || c.score === undefined ? '—' : String(int(c.score)),
          verdict: verdict || '—',
          verdictClass: verdictClass(verdict),
          tx: shortAddr(c.tx_sig),
          txHref: solscanTx(c.tx_sig, network),
          payer: shortAddr(c.payer),
          party: c.party === 'unattributed' ? 'unattributed' : typeof c.first_party === 'boolean' ? (c.first_party ? 'first-party' : 'third-party') : 'unlabelled',
          latency: c.latency_ms === null || c.latency_ms === undefined ? '—' : `${int(c.latency_ms)} ms`,
        };
      }),
    caught: rows(s.caught)
      .slice(0, 50)
      .map((row) => {
        const c = obj(row) ?? {};
        const meta = metadataOf(c);
        const verdict = safeText(c.verdict, 8).toUpperCase();
        return {
          mint: shortAddr(c.mint),
          mintHref: solscanMint(c.mint),
          symbol: meta.symbol || null,
          name: meta.name || null,
          description: meta.description || null,
          verdict,
          verdictClass: verdictClass(verdict),
          scoredAgo: fmtAgo(c.scored_at, now),
          outcome: safeText(c.outcome, 16) || '—',
          outcomeAgo: fmtAgo(c.outcome_at, now),
        };
      }),
    backtest: backtest
      ? {
          model: safeText(backtest.model_version, 24) || '—',
          n: String(n),
          precision: fmtPct(num(backtest.precision_high_plus, NaN)),
          recall: fmtPct(num(backtest.recall_high_plus, NaN)),
          small: n < 100,
          caveat: safeText(backtest.caveat, 160) || null,
        }
      : null,
  };
}

export function backtestText(backtest) {
  if (!backtest) return 'Backtest not run yet — precision/recall will appear here once v0 labels land.';
  const caveat = backtest.caveat ? ` — ${backtest.caveat}` : '';
  if (backtest.n === '0') return `${backtest.model}: harness ran, no labelled launches yet (n = 0)${caveat}`;
  return (
    `${backtest.model}: precision at HIGH+ ${backtest.precision}, recall ${backtest.recall}, n = ${backtest.n}` +
    (backtest.small ? ' (small sample — indicative only)' : '') + caveat
  );
}

// ---------- DOM (browser only; textContent everywhere) ----------

function el(tag, text, attrs) {
  const node = document.createElement(tag);
  if (text !== null && text !== undefined) node.textContent = text;
  if (attrs) for (const k of Object.keys(attrs)) if (attrs[k] !== null) node.setAttribute(k, String(attrs[k]));
  return node;
}

/** 44px-tall tap target; href may only be a value that passed the base58 check (else plain text). */
function actionLink(label, href) {
  const a = el('a', null, href ? { href, target: '_blank', rel: 'noopener noreferrer' } : { class: 'unlinked', role: 'text' });
  a.append(el('span', label), el('span', href ? '↗' : '—', { class: 'arrow', 'aria-hidden': 'true' }));
  return a;
}

function replace(host, children) {
  if (host) host.replaceChildren(...children);
}

/** dt/dd pair; `value` is a plain string or a node. Text always lands via textContent. */
function row(dl, label, value) {
  const dd = el('dd');
  if (typeof value === 'string') dd.textContent = value;
  else if (value) dd.append(value);
  dl.append(el('dt', label), dd);
}

function tokenLine(c) {
  if (!c.name && !c.symbol) return null;
  const p = el('p', null, { class: 'token' });
  if (c.name) p.append(el('span', c.name));
  if (c.symbol) p.append(el('span', c.symbol, { class: 'sym' }));
  return p;
}

function callCard(c) {
  const li = el('li', null, { class: 'call' });
  const head = el('div', null, { class: 'call-head' });
  head.append(
    el('span', `${c.score} ${c.verdict}`, { class: `badge ${c.verdictClass}` }),
    el('span', c.ago),
    el('span', c.party, { class: 'party' }),
  );
  li.append(head);

  const token = tokenLine(c);
  if (token) li.append(token);
  // Token description, when the stats payload carries one: attacker-controlled, so textContent + clamp.
  if (c.description) li.append(el('p', c.description, { class: 'note' }));

  const dl = el('dl', null, { class: 'kv' });
  row(dl, 'tool', c.tool);
  row(dl, 'mint', c.mint);
  row(dl, 'payer', c.payer);
  row(dl, 'latency', c.latency);
  li.append(dl);

  const links = el('div', null, { class: 'links' });
  links.append(actionLink(`mint ${c.mint}`, c.mintHref), actionLink(`payment tx ${c.tx}`, c.txHref));
  li.append(links);
  return li;
}

function caughtCard(c) {
  const li = el('li', null, { class: 'call' });
  const head = el('div', null, { class: 'call-head' });
  head.append(el('span', c.verdict, { class: `badge ${c.verdictClass}` }), el('span', `scored ${c.scoredAgo}`), el('span', `died ${c.outcomeAgo}`));
  li.append(head);

  const token = tokenLine(c);
  if (token) li.append(token);

  const dl = el('dl', null, { class: 'kv' });
  row(dl, 'mint', c.mint);
  row(dl, 'outcome', c.outcome);
  row(dl, 'scored', c.scoredAgo);
  row(dl, 'labelled', c.outcomeAgo);
  li.append(dl);

  const links = el('div', null, { class: 'links' });
  links.append(actionLink(`mint ${c.mint}`, c.mintHref));
  li.append(links);
  return li;
}

function emptyItem(text) {
  return el('li', text, { class: 'call empty' });
}

/** Render a StatsResponse into the [data-*] hosts of the /live page. */
export function render(root, stats, now) {
  const vm = buildViewModel(stats, now);
  const q = (sel) => (root && typeof root.querySelector === 'function' ? root.querySelector(sel) : null);

  const set = (sel, text) => {
    const host = q(sel);
    if (host) host.textContent = text;
  };
  set('[data-network]', vm.networkLabel);
  set('[data-model]', vm.modelVersion);
  set('[data-updated]', vm.generatedAgo);
  set('[data-split]', vm.split.text);
  set('[data-backtest]', backtestText(vm.backtest));

  replace(
    q('[data-counters]'),
    vm.counters.map((c) => {
      const box = el('div', null, { class: 'counter' });
      box.append(el('div', c.value, { class: 'value' }), el('div', c.label, { class: 'label' }));
      return box;
    }),
  );
  replace(q('[data-calls]'), vm.calls.length ? vm.calls.map(callCard) : [emptyItem('No paid calls yet.')]);
  replace(q('[data-caught]'), vm.caught.length ? vm.caught.map(caughtCard) : [emptyItem('Nothing caught yet.')]);
  return vm;
}

/** Fetch /v1/stats, render, then poll. Returns a stop function. */
export async function main(root = document, fetchImpl = fetch, intervalMs = 15000) {
  const errorHost = root && typeof root.querySelector === 'function' ? root.querySelector('[data-error]') : null;
  const tick = async () => {
    try {
      const res = await fetchImpl(STATS_URL, { headers: { accept: 'application/json' }, cache: 'no-store' });
      if (!res.ok) throw new Error(`stats ${res.status}`);
      render(root, await res.json());
      if (errorHost) errorHost.textContent = '';
    } catch (err) {
      if (errorHost) errorHost.textContent = `stats unavailable — retrying (${safeText(err && err.message, 64)})`;
    }
  };
  await tick();
  const timer = intervalMs > 0 && typeof setInterval === 'function' ? setInterval(tick, intervalMs) : null;
  return () => {
    if (timer) clearInterval(timer);
  };
}

if (typeof document !== 'undefined' && typeof document.querySelector === 'function' && document.querySelector('[data-live-root]')) {
  void main(document);
}
