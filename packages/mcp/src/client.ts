import { x402Client, wrapFetchWithPayment, type SchemeNetworkClient } from '@x402/fetch';
import type { PaymentRequirements } from '@x402/core/types';
import { usdcMintFor, type Config } from './config.js';
import type { SpendStore } from './spend.js';

export type ErrorCode =
  | 'INVALID_MINT' | 'NOT_FOUND' | 'PRICE_ABOVE_CAP' | 'DAILY_CAP_REACHED'
  | 'WRONG_NETWORK' | 'WRONG_ASSET' | 'INSUFFICIENT_FUNDS' | 'UPSTREAM';

export class ToolError extends Error {
  constructor(readonly code: ErrorCode, message: string = code) {
    super(message);
  }
}

export const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Client policy (INTERFACES §6.1). Pure apart from the spend reservation; throws ToolError
 * before anything is signed. Returns the reserved amount (USDC base units).
 */
export function enforcePolicy(cfg: Config, spend: SpendStore, req: PaymentRequirements): number {
  if (req.scheme !== 'exact') throw new ToolError('WRONG_ASSET', 'unsupported payment scheme');
  if (req.network !== cfg.network) throw new ToolError('WRONG_NETWORK');
  const usdc = usdcMintFor(cfg.network);
  // ANSEM has no verified mint / USD price yet (VERIFY), so only USDC is payable.
  if (cfg.payAsset !== 'USDC' || !usdc || req.asset !== usdc) throw new ToolError('WRONG_ASSET');
  if (!/^[0-9]{1,15}$/.test(req.amount)) throw new ToolError('UPSTREAM', 'malformed amount');
  const amount = Number(req.amount);
  if (amount > cfg.maxPriceMicro) throw new ToolError('PRICE_ABOVE_CAP');
  if (!spend.reserve(amount, cfg.dailyCapMicro)) throw new ToolError('DAILY_CAP_REACHED');
  return amount;
}

export interface PayDeps {
  cfg: Config;
  spend: SpendStore;
  scheme: SchemeNetworkClient;
  /** Payer's base58 address (public). */
  payer: string;
  /** Payer's balance of `mint` in base units on cfg.network; 0n if no token account. */
  getBalance: (owner: string, mint: string) => Promise<bigint>;
  fetchImpl?: typeof fetch;
}

function mapFailure(message: string): ToolError {
  return /insufficient|not enough|no record of a prior credit|balance/i.test(message)
    ? new ToolError('INSUFFICIENT_FUNDS')
    : new ToolError('UPSTREAM');
}

/** GET the paid risk endpoint, paying via x402 with caps enforced before signing. Returns parsed JSON. */
export async function fetchRiskResult(deps: PayDeps, mint: string): Promise<unknown> {
  const { cfg, spend } = deps;
  if (!MINT_RE.test(mint)) throw new ToolError('INVALID_MINT');

  let policyError: ToolError | undefined;
  let reserved = 0;
  // Our own policy below is the single gate (stricter than the library defaults), so library spend controls are off.
  const client = x402Client.fromConfig({
    // Wildcard so a wrong-network offer reaches our policy (WRONG_NETWORK) instead of failing in selection.
    schemes: [{ network: 'solana:*', client: deps.scheme }],
    spendControls: false,
  });
  client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
    try {
      reserved = enforcePolicy(cfg, spend, selectedRequirements);
      // Still before signing: refuse if the payer cannot cover the amount (missing token account = 0).
      let balance: bigint;
      try {
        balance = await deps.getBalance(deps.payer, selectedRequirements.asset);
      } catch {
        throw new ToolError('UPSTREAM', 'balance check failed');
      }
      if (balance < BigInt(selectedRequirements.amount)) throw new ToolError('INSUFFICIENT_FUNDS');
    } catch (e) {
      // Abort happens outside the library's failure hook, so return the reservation here.
      if (reserved > 0) spend.release(reserved);
      reserved = 0;
      policyError = e instanceof ToolError ? e : new ToolError('UPSTREAM');
      return { abort: true, reason: policyError.code };
    }
  });
  client.onPaymentCreationFailure(async () => {
    // Nothing was signed/sent: give the reservation back.
    if (reserved > 0) spend.release(reserved);
    reserved = 0;
  });

  const pay = wrapFetchWithPayment(deps.fetchImpl ?? fetch, client);
  let res: Response;
  try {
    // x-pwire-holder: ask for the $PWIRE holder price for the paying wallet. The API ignores it unless that wallet
    // holds the tier balance, and then only accepts the discounted payment from that same wallet.
    res = await pay(`${cfg.apiUrl}/v1/risk/${mint}`, {
      headers: { accept: 'application/json', 'x-pwire-holder': deps.payer },
    });
  } catch (e) {
    if (policyError) throw policyError;
    throw mapFailure(e instanceof Error ? e.message : '');
  }

  if (res.status === 200) return res.json();
  // Refused before settlement (bad mint, unknown mint, payment rejected, holder check unavailable): nothing was spent.
  if ([400, 402, 404, 503].includes(res.status) && reserved > 0) {
    spend.release(reserved);
    reserved = 0;
  }
  let body: { error?: string; message?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // non-JSON error body
  }
  if (res.status === 400) throw new ToolError('INVALID_MINT');
  if (res.status === 404) throw new ToolError('NOT_FOUND');
  if (res.status === 402) throw mapFailure(`${body.message ?? ''}`);
  throw new ToolError('UPSTREAM');
}
