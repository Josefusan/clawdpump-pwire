// PumpWire /live — browser renderer. Pure functions are exported for vitest; DOM work uses textContent only
// (INTERFACES §1: live must never render metadata strings as HTML). No framework, no build step.

export const SOLSCAN_CLUSTER = {
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': '',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': '?cluster=devnet',
  'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z': '?cluster=testnet',
};
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;

/** Strip anything that is not printable ASCII; clamp. Defensive even though the API validates base58. */
export function safeText(v, max = 96) {
  const s = v == null ? '' : String(v);
  return s.replace(/[^\x20-\x7e]/g, '').slice(0, max);
}
export function isBase58(v) { return typeof v === 'string' && BASE58.test(v); }
export function shortAddr(v) { const s = safeText(v); return s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s; }
export function solscanTx(sig, network) { return isBase58(sig) ? `https://solscan.io/tx/${sig}${SOLSCAN_CLUSTER[network] ?? ''}` : null; }
export function solscanAccount(addr, network) { return isBase58(addr) ? `https://solscan.io/account/${addr}${SOLSCAN_CLUSTER[network] ?? ''}` : null; }
export function fmtAmount(decStr, symbol) {
  const n = Number(decStr);
  if (!Number.isFinite(n)) return `0 ${symbol}`;
  return `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${symbol}`;
}
export function fmtPct(x) { return Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : '—'; }
export function fmtAgo(ts, now = Math.floor(Date.now() / 1000)) {
  const d = Math.max(0, now - Number(ts || 0));
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}
export function networkLabel(network) {
  return network === 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' ? 'Solana mainnet'
    : network === 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' ? 'Solana devnet' : safeText(network, 48);
}

/** StatsResponse (INTERFACES §4.3) → plain strings/links the DOM code can drop in with textContent. */
export function buildViewModel(stats, now) {
  const s = stats && typeof stats === 'object' ? stats : {};
  const t = s.totals || {};
  const network = typeof s.network === 'string' ? s.network : '';
  const paid = Number(t.paid_calls || 0);
  const fp = Number(t.paid_calls_first_party || 0);
  const tp = Number(t.paid_calls_third_party || 0);
  const calls = Array.isArray(s.last_calls) ? s.last_calls.slice(0, 50) : [];
  const caught = Array.isArray(s.caught) ? s.caught.slice(0, 50) : [];
  const bt = s.backtest && typeof s.backtest === 'object' ? s.backtest : null;
  return {
    network, networkLabel: networkLabel(network),
    modelVersion: safeText(s.model_version, 24) || '—',
    generatedAgo: s.generated_at ? fmtAgo(s.generated_at, now) : '—',
    counters: [
      { label: 'paid calls', value: String(paid) },
      { label: 'USDC paid', value: fmtAmount(t.usdc_paid ?? '0', 'USDC') },
      { label: '$ANSEM paid', value: fmtAmount(t.ansem_paid ?? '0', 'ANSEM') },
      { label: 'unique payers', value: String(Number(t.unique_payers || 0)) },
      { label: 'integrators', value: String(Number(t.unique_integrators || 0)) },
    ],
    split: { firstParty: fp, thirdParty: tp, firstPartyPct: paid > 0 ? fp / paid : 0 },
    calls: calls.map((c) => ({
      ago: fmtAgo(c.ts, now),
      tool: safeText(c.tool, 24),
      arg: shortAddr(c.arg), argHref: solscanAccount(c.arg, network),
      score: c.score == null ? '—' : String(Number(c.score)),
      verdict: safeText(c.verdict, 8) || '—',
      tx: shortAddr(c.tx_sig), txHref: solscanTx(c.tx_sig, network),
      payer: shortAddr(c.payer),
      party: c.first_party ? 'first-party' : 'third-party',
      latency: c.latency_ms == null ? '—' : `${Number(c.latency_ms)} ms`,
    })),
    caught: caught.map((c) => ({
      mint: shortAddr(c.mint), mintHref: solscanAccount(c.mint, network),
      verdict: safeText(c.verdict, 8), scoredAgo: fmtAgo(c.scored_at, now),
      outcome: safeText(c.outcome, 16), outcomeAgo: fmtAgo(c.outcome_at, now),
    })),
    backtest: bt ? {
      model: safeText(bt.model_version, 24), n: String(Number(bt.n || 0)),
      precision: fmtPct(Number(bt.precision_high_plus)), recall: fmtPct(Number(bt.recall_high_plus)),
      small: Number(bt.n || 0) < 100,
    } : null,
  };
}

// ---------- DOM (browser only) ----------
function el(tag, text, attrs) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;              // text only, never markup
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  return e;
}
function link(text, href) {
  if (!href) return el('span', text);
  return el('a', text, { href, target: '_blank', rel: 'noopener noreferrer' });
}
function replaceChildren(node, children) { node.replaceChildren(...children); }

export function render(root, stats, now) {
  const vm = buildViewModel(stats, now);
  root.querySelector('[data-network]').textContent = vm.networkLabel;
  root.querySelector('[data-model]').textContent = vm.modelVersion;
  root.querySelector('[data-updated]').textContent = vm.generatedAgo;

  replaceChildren(root.querySelector('[data-counters]'), vm.counters.map((c) => {
    const box = el('div', null, { class: 'counter' });
    box.append(el('div', c.value, { class: 'value' }), el('div', c.label, { class: 'label' }));
    return box;
  }));
  root.querySelector('[data-split]').textContent =
    `${vm.split.firstParty} first-party (our Scout) · ${vm.split.thirdParty} third-party (${fmtPct(1 - vm.split.firstPartyPct)} external)`;

  replaceChildren(root.querySelector('[data-calls]'), vm.calls.length ? vm.calls.map((c) => {
    const tr = el('tr', null, { class: c.party });
    tr.append(el('td', c.ago), el('td', c.tool), el('td').appendChild(link(c.arg, c.argHref)).parentNode,
      el('td', `${c.score} ${c.verdict}`), el('td').appendChild(link(c.tx, c.txHref)).parentNode,
      el('td', c.payer), el('td', c.party), el('td', c.latency));
    return tr;
  }) : [emptyRow(8, 'No paid calls yet.')]);

  replaceChildren(root.querySelector('[data-caught]'), vm.caught.length ? vm.caught.map((c) => {
    const tr = el('tr');
    tr.append(el('td').appendChild(link(c.mint, c.mintHref)).parentNode, el('td', `${c.verdict} ${c.scoredAgo}`), el('td', `${c.outcome} ${c.outcomeAgo}`));
    return tr;
  }) : [emptyRow(3, 'Nothing caught yet. Only tokens scored HIGH/EXTREME before they died appear here.')]);

  const b = root.querySelector('[data-backtest]');
  b.textContent = vm.backtest
    ? `${vm.backtest.model}: precision at HIGH+ ${vm.backtest.precision}, recall ${vm.backtest.recall}, n = ${vm.backtest.n}${vm.backtest.small ? ' (small sample — treat as indicative only)' : ''}`
    : 'Backtest not run yet.';
}
function emptyRow(cols, text) { const tr = el('tr'); tr.append(el('td', text, { colspan: String(cols), class: 'empty' })); return tr; }

export async function main(root = document, fetchImpl = fetch, intervalMs = 10000) {
  async function tick() {
    try {
      const res = await fetchImpl('/v1/stats', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`stats ${res.status}`);
      render(root, await res.json());
      root.querySelector('[data-error]').textContent = '';
    } catch (e) {
      root.querySelector('[data-error]').textContent = `stats unavailable (${safeText(e && e.message, 64)})`;
    }
  }
  await tick();
  if (intervalMs > 0) setInterval(tick, intervalMs);
}

if (typeof document !== 'undefined' && document.querySelector('[data-live-root]')) {
  main(document);
}
