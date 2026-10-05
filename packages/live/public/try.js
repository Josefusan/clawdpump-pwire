// PumpWire /live — hero terminal + "Try it" (pay one call from a browser wallet).
// Same rules as live.js: every dynamic string reaches the DOM through textContent; hrefs only from base58-checked values.
import { safeText, shortAddr, solscanTx, solscanMint, verdictClass, isPubkey } from '/live/live.js';

const $ = (sel) => document.querySelector(sel);
const API = location.origin;
const MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

function el(tag, text, attrs) {
  const n = document.createElement(tag);
  if (text !== null && text !== undefined) n.textContent = text;
  if (attrs) for (const k of Object.keys(attrs)) n.setAttribute(k, String(attrs[k]));
  return n;
}

let latest = null; // last /v1/stats payload (from live.js)
window.addEventListener('pumpwire:stats', (e) => {
  latest = e.detail;
  fillRecent();
});
for (const o of document.querySelectorAll('[data-origin]')) o.textContent = o.classList.contains('s') ? `"${API}"` : API;

// ---------- hero terminal ----------
const term = $('[data-term]');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function scriptFor(call) {
  const mint = call ? shortAddr(call.arg) : '7xKX…pump';
  const score = call && Number.isFinite(Number(call.score)) ? String(Math.trunc(Number(call.score))) : '78';
  const verdict = call ? safeText(call.verdict, 8) || 'EXTREME' : 'EXTREME';
  const tx = call ? shortAddr(call.tx_sig) : '2g4V…sqGyP';
  const ms = call && Number.isFinite(Number(call.latency_ms)) ? `${(Number(call.latency_ms) / 1000).toFixed(1)} s` : '2.1 s';
  const vcls = /HIGH|EXTREME/.test(verdict) ? 'r' : verdict === 'MED' ? 'y' : 'p';
  return [
    [['c', '# an AI agent checks a new pump.fun launch']],
    [['p', '$ '], ['', `rug_risk_score("${mint}")`]],
    [['b', '→ '], ['', `GET /v1/risk/${mint}`]],
    [['y', '← 402 Payment Required'], ['c', '  x402 · exact · solana']],
    [['c', '   price '], ['', '0.01 USDC'], ['c', ' · memo binds this request']],
    [['v', '✎ '], ['', 'agent wallet signs one USDC transfer'], ['c', '  (fee paid by facilitator)']],
    [['b', '→ '], ['', `GET /v1/risk/${mint}`], ['c', '  PAYMENT-SIGNATURE: eyJ4…']],
    [['p', '← 200 OK  '], ['', 'score '], [vcls, `${score} ${verdict}`], ['c', `  · ${ms}`]],
    [['p', '✓ settled on Solana  '], ['b', tx]],
  ];
}

async function runTerminal() {
  if (!term) return;
  // Wait briefly for the first /v1/stats so the terminal replays a real settled call.
  for (let i = 0; i < 30 && !latest; i++) await sleep(100);
  for (;;) {
    const calls = (latest && Array.isArray(latest.last_calls) ? latest.last_calls : []).filter((c) => c && c.tx_sig);
    const call = calls.length ? calls[Math.floor(Math.random() * Math.min(calls.length, 10))] : null;
    term.replaceChildren();
    for (const line of scriptFor(call)) {
      const p = el('p');
      term.append(p);
      for (const [cls, text] of line) {
        const span = el('span', '', cls ? { class: cls } : undefined);
        p.append(span);
        if (reduced) { span.textContent = text; continue; }
        for (let i = 1; i <= text.length; i += 2) {
          span.textContent = text.slice(0, i);
          await sleep(12);
        }
        span.textContent = text;
      }
      await sleep(reduced ? 0 : 380);
    }
    const last = el('p');
    last.append(el('span', '$ ', { class: 'p' }), el('span', '', { class: 'cursor' }));
    term.append(last);
    await sleep(reduced ? 60000 : 5200);
  }
}
void runTerminal();

// ---------- Try it ----------
const mintIn = $('[data-try-mint]');
const msg = $('[data-try-msg]');
const offerBox = $('[data-try-offer]');
const walletsBox = $('[data-try-wallets]');
const progress = $('[data-try-progress]');
let pay = null; // pay.js module
let conn = null;
let busy = false;

const payReady = import('/live/pay.js').then((m) => (pay = m)).catch(() => null);

function say(text, kind) {
  msg.textContent = text;
  msg.className = `tmsg${kind ? ` ${kind}` : ''}`;
}

function fillRecent() {
  const host = $('[data-try-recent]');
  if (!host || !latest) return;
  const seen = new Set();
  const mints = [];
  for (const c of Array.isArray(latest.last_calls) ? latest.last_calls : []) {
    if (c && isPubkey(c.arg) && !seen.has(c.arg)) { seen.add(c.arg); mints.push(c); }
    if (mints.length >= 4) break;
  }
  if (host.childElementCount && host.dataset.filled === '1') return;
  host.replaceChildren(el('span', 'Recent:', { class: 'note', style: 'align-self:center' }));
  for (const c of mints) {
    const b = el('button', shortAddr(c.arg), { type: 'button', title: 'Use this mint' });
    b.addEventListener('click', () => { mintIn.value = c.arg; void check(); });
    host.append(b);
  }
  host.dataset.filled = '1';
}

function setStep(step) {
  const order = ['offer', 'sign', 'settle', 'done'];
  const at = order.indexOf(step);
  for (const li of progress.querySelectorAll('li')) {
    const i = order.indexOf(li.dataset.p);
    li.className = i < at || step === 'done' ? 'done' : i === at ? 'on' : '';
  }
}

const usd = (base) => `$${(Number(base) / 1e6).toFixed(Number(base) % 10000 ? 3 : 2)}`;

function friendly(e) {
  const m = safeText(e && e.message, 200);
  if (/reject|denied|cancel|declined/i.test(m)) return 'You cancelled in the wallet. Nothing was paid.';
  return m || 'Something went wrong. Nothing was paid.';
}

async function check() {
  if (busy) return;
  const mint = mintIn.value.trim();
  offerBox.hidden = true;
  if (!isPubkey(mint)) return say('Paste a Solana token mint, or pick a recent launch.', 'bad');
  say('Asking PumpWire for its price (free)…');
  await payReady;
  if (!pay) return say('The payment module did not load. Reload the page.', 'bad');
  try {
    const offer = await pay.probe(API, mint, conn ? conn.address : undefined);
    $('[data-try-amt]').textContent = usd(offer.amount);
    $('[data-try-amtnote]').textContent = offer.holder ? 'USDC · $PWIRE holder price' : 'USDC · one call · HTTP 402 offer';
    offerBox.hidden = false;
    renderWallets();
    say(conn ? 'Ready. Press pay and approve in your wallet.' : 'Price received. Connect a wallet to pay.', 'good');
  } catch (e) {
    say(friendly(e), 'bad');
  }
}

function renderWallets() {
  walletsBox.replaceChildren();
  if (conn) {
    const b = el('button', null, { type: 'button', class: 'btn primary' });
    b.append(el('span', `Pay ${$('[data-try-amt]').textContent} and get the score`));
    b.addEventListener('click', () => void doPay());
    walletsBox.append(b, el('span', `wallet ${shortAddr(conn.address)}`, { class: 'chip', style: 'align-self:center' }));
    return;
  }
  const list = pay ? pay.wallets() : [];
  if (!list.length) {
    walletsBox.append(el('p', 'No Solana wallet found in this browser. Install Phantom, Solflare or Backpack, then reload.', { class: 'note' }));
    return;
  }
  for (const w of list) {
    const b = el('button', null, { type: 'button', class: 'btn' });
    if (typeof w.icon === 'string' && /^data:image\/(svg\+xml|png|webp|jpeg);base64,/.test(w.icon)) b.append(el('img', null, { src: w.icon, alt: '' }));
    b.append(el('span', `Connect ${safeText(w.name, 32)}`));
    b.addEventListener('click', async () => {
      try {
        say('Approve the connection in your wallet…');
        conn = await pay.connect(w.name);
        say(`Connected wallet ${shortAddr(conn.address)}.`, 'good');
        await check(); // re-ask: a $PWIRE holder gets the $0.005 offer
      } catch (e) {
        say(friendly(e), 'bad');
      }
    });
    walletsBox.append(b);
  }
}

async function doPay() {
  if (busy || !conn || !pay) return;
  const mint = mintIn.value.trim();
  if (!isPubkey(mint)) return say('Paste a Solana token mint first.', 'bad');
  busy = true;
  progress.hidden = false;
  setStep('offer');
  say('Working…');
  try {
    const paid = await pay.payForScore({
      apiBase: API, mint, conn,
      onStep: (s, o) => {
        setStep(s);
        if (s === 'sign') say(`Approve the ${o ? usd(o.amount) : ''} USDC transfer in your wallet…`.replace('  ', ' '));
        if (s === 'settle') say('Settling on Solana…');
      },
    });
    setStep('done');
    showResult(paid);
    say(`Paid ${usd(paid.offer ? paid.offer.amount : 10000)} USDC. Your call appears in the live feed below in a few seconds.`, 'good');
  } catch (e) {
    progress.hidden = true;
    say(friendly(e), 'bad');
  } finally {
    busy = false;
  }
}

function showResult(paid) {
  const r = paid.result || {};
  const score = Math.max(0, Math.min(100, Math.trunc(Number(r.score) || 0)));
  const verdict = safeText(r.verdict, 8).toUpperCase() || '—';
  $('[data-try-placeholder]').hidden = true;
  $('[data-try-result]').classList.add('show');
  $('[data-r-score]').textContent = String(score);
  const badge = $('[data-r-verdict]');
  badge.textContent = verdict;
  badge.className = `badge ${verdictClass(verdict)}`;
  requestAnimationFrame(() => $('[data-r-needle]').setAttribute('style', `left:calc(${score}% - 2px)`));
  const reasons = Array.isArray(r.reasons) ? r.reasons.slice(0, 6) : [];
  $('[data-r-reasons]').replaceChildren(
    ...(reasons.length
      ? reasons.map((x) => {
          const li = el('li');
          li.append(el('span', `+${Math.trunc(Number(x && x.points) || 0)}`, { class: 'pts' }), el('span', safeText(x && x.detail, 160) || safeText(x && x.factor, 32)));
          return li;
        })
      : [el('li', 'No risk factor fired for this launch yet.')]),
  );
  const links = $('[data-r-links]');
  links.replaceChildren();
  const add = (label, href) => {
    if (!href) return;
    const a = el('a', null, { href, target: '_blank', rel: 'noopener noreferrer' });
    a.append(el('span', label), el('span', '↗', { class: 'arrow', 'aria-hidden': 'true' }));
    links.append(a);
  };
  add(`your payment ${shortAddr(paid.tx)}`, solscanTx(paid.tx, MAINNET));
  add(`mint ${shortAddr(r.mint)}`, solscanMint(r.mint));
}

$('[data-try-check]').addEventListener('click', () => void check());
mintIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') void check(); });
mintIn.addEventListener('input', () => { offerBox.hidden = true; });
