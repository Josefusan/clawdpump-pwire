// PumpWire /live "Try it": pay one rug_risk_score call from a browser wallet (Phantom, Solflare, Backpack, ...).
// Bundled to public/pay.js with `bun run build:pay` (committed, so the server needs no bundler).
//
// Flow: free 402 probe -> the user connects a Wallet Standard wallet -> the stock @x402/svm client builds the
// exact payment tx (fee payer = facilitator) -> the wallet signs it (solana:signTransaction) -> GET again with the
// payment header -> score. The server checks everything again; the client checks are a second guard so the page
// never asks a wallet to sign more than one call at the advertised price.
import { getTransactionDecoder, getTransactionEncoder, type Address, type Transaction } from '@solana/kit';
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { ExactSvmScheme } from '@x402/svm';

export const MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const USDC_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** Hard ceiling for one call, in USDC base units ($0.01). The API price is 10000, or 5000 for $PWIRE holders. */
export const MAX_AMOUNT = 10_000n;
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ---------- Wallet Standard (no adapter library) ----------
interface WalletAccount { address: string; chains: readonly string[]; features: readonly string[] }
interface StdWallet {
  name: string;
  icon: string;
  chains: readonly string[];
  accounts: readonly WalletAccount[];
  features: Record<string, any>;
}

const found: StdWallet[] = [];
const register = (...ws: StdWallet[]) => {
  for (const w of ws) if (!found.includes(w)) found.push(w);
  return () => {};
};
if (typeof window !== 'undefined') {
  window.addEventListener('wallet-standard:register-wallet', (e: any) => {
    try { e.detail({ register }); } catch { /* a broken wallet must not break the page */ }
  });
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register } }));
}

const usable = (w: StdWallet) =>
  w.chains.some((c) => c === 'solana:mainnet') && !!w.features['standard:connect'] && !!w.features['solana:signTransaction'];

/** Wallets that can sign a Solana mainnet transaction. */
export function wallets(): { name: string; icon: string }[] {
  return found.filter(usable).map((w) => ({ name: w.name, icon: w.icon }));
}

export interface Connected { wallet: StdWallet; account: WalletAccount; address: string }

export async function connect(name: string): Promise<Connected> {
  const wallet = found.filter(usable).find((w) => w.name === name);
  if (!wallet) throw new Error('wallet not found');
  const { accounts } = await wallet.features['standard:connect'].connect();
  const account = (accounts as WalletAccount[]).find((a) => MINT_RE.test(a.address)) ?? wallet.accounts[0];
  if (!account) throw new Error('the wallet returned no account');
  return { wallet, account, address: account.address };
}

/**
 * A kit TransactionModifyingSigner backed by the wallet. Wallets may return a re-encoded transaction, so we take the
 * signed bytes they return instead of only a signature. The API and the facilitator verify the result in full.
 */
export function walletSigner(c: Connected, chain = 'solana:mainnet') {
  const enc = getTransactionEncoder();
  const dec = getTransactionDecoder();
  return {
    address: c.address as Address,
    async modifyAndSignTransactions(txs: readonly Transaction[]): Promise<Transaction[]> {
      const out: Transaction[] = [];
      for (const tx of txs) {
        const [res] = await c.wallet.features['solana:signTransaction'].signTransaction({
          account: c.account,
          chain,
          transaction: new Uint8Array(enc.encode(tx)),
        });
        const signed = dec.decode(res.signedTransaction) as Transaction;
        out.push({ ...signed, ...('lifetimeConstraint' in tx ? { lifetimeConstraint: (tx as any).lifetimeConstraint } : {}) } as Transaction);
      }
      return out;
    },
  };
}

// ---------- the call ----------
export interface Offer { amount: bigint; asset: string; network: string; payTo: string; holder: boolean }
export type Step = 'offer' | 'sign' | 'settle' | 'done';

function offerOf(body: any): Offer {
  const a = body?.accepts?.[0];
  if (!a || a.scheme !== 'exact') throw new Error('unexpected payment offer');
  if (!/^[0-9]{1,15}$/.test(String(a.amount))) throw new Error('malformed price');
  const amount = BigInt(a.amount);
  return { amount, asset: String(a.asset), network: String(a.network), payTo: String(a.payTo), holder: amount < MAX_AMOUNT };
}

/** The network and asset the page accepts. Mainnet USDC on /live; tests pass devnet. */
export interface Expect { network: string; asset: string; chain: string }
export const EXPECT_MAINNET: Expect = { network: MAINNET, asset: USDC_MAINNET, chain: 'solana:mainnet' };

function guard(o: Offer, x: Expect) {
  if (o.network !== x.network) throw new Error('the offer is on the wrong network');
  if (o.asset !== x.asset) throw new Error('the offer is not in USDC');
  if (o.amount <= 0n || o.amount > MAX_AMOUNT) throw new Error('the price is above $0.01; refusing to sign');
}

/** Free: ask the API for its price. 402 = known mint (returns the offer), 404 = unknown mint. */
export async function probe(apiBase: string, mint: string, holder?: string, x: Expect = EXPECT_MAINNET): Promise<Offer> {
  if (!MINT_RE.test(mint)) throw new Error('that is not a Solana address');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (holder) headers['x-pwire-holder'] = holder;
  const res = await fetch(`${apiBase}/v1/risk/${mint}`, { headers, cache: 'no-store' });
  if (res.status === 404) throw new Error('PumpWire has not seen this mint yet. Pick a recent pump.fun launch.');
  if (res.status === 400) throw new Error('that is not a Solana address');
  if (res.status === 429) throw new Error('too many requests; wait a minute');
  if (res.status !== 402) throw new Error(`unexpected response ${res.status}`);
  const offer = offerOf(await res.json());
  guard(offer, x);
  return offer;
}

export interface Paid { result: any; tx: string | null; offer: Offer }

/** Pay for one score from the connected wallet. Throws before signing if the offer fails the guard. */
export async function payForScore(opts: {
  apiBase: string; mint: string; conn: Connected; rpcUrl?: string; expect?: Expect; onStep?: (s: Step, o?: Offer) => void;
}): Promise<Paid> {
  const { apiBase, mint, conn, onStep } = opts;
  const x = opts.expect ?? EXPECT_MAINNET;
  if (!MINT_RE.test(mint)) throw new Error('that is not a Solana address');
  let offer: Offer | null = null;
  const client = x402Client.fromConfig({
    schemes: [{ network: 'solana:*', client: new ExactSvmScheme(walletSigner(conn, x.chain) as any, opts.rpcUrl ? { rpcUrl: opts.rpcUrl } : undefined) }],
    spendControls: false,
  } as any);
  client.onBeforePaymentCreation(async ({ selectedRequirements }: any) => {
    try {
      offer = offerOf({ accepts: [selectedRequirements] });
      guard(offer, x);
    } catch (e) {
      return { abort: true, reason: e instanceof Error ? e.message : 'refused' };
    }
    onStep?.('sign', offer);
  });
  const pay = wrapFetchWithPayment(fetch, client);
  onStep?.('offer');
  const res = await pay(`${apiBase}/v1/risk/${mint}`, {
    headers: { accept: 'application/json', 'x-pwire-holder': conn.address },
    cache: 'no-store',
  });
  onStep?.('settle', offer ?? undefined);
  let body: any = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (res.status !== 200) {
    const msg = body?.message ?? body?.error ?? `HTTP ${res.status}`;
    throw new Error(/insufficient|balance|no record of a prior credit/i.test(msg) ? 'not enough USDC in this wallet (needs $0.01 + nothing else; the fee is paid for you)' : msg);
  }
  const tx = txFromHeader(res.headers.get('payment-response'));
  onStep?.('done', offer ?? undefined);
  return { result: body, tx, offer: offer! };
}

/** The settled tx signature from the PAYMENT-RESPONSE header (base64 JSON), or null. */
export function txFromHeader(h: string | null): string | null {
  if (!h) return null;
  try {
    const j = JSON.parse(atob(h));
    return typeof j.transaction === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(j.transaction) ? j.transaction : null;
  } catch {
    return null;
  }
}
