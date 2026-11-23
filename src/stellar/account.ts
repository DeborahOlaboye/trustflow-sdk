import { Keypair } from '@stellar/stellar-sdk';
import { TrustFlowError } from '../errors';
import { withTransientRetry } from '../utils/node-retry';
import type { ApiRetryConfig } from '../utils/http';
import { DEFAULT_TIMEOUT_MS, fetchWithTimeout } from '../utils/timeout';
import { assertStellarAddress } from '../utils/validation';
import { getNetworkConfig, StellarNetwork } from './network';

export interface AccountInfo {
  address: string;
  balanceXLM: string;
  sequenceNumber: string;
  isActive: boolean;
}

/** A credit-asset trustline held by an account (a non-native balance). */
export interface AccountTrustline {
  /** Asset code, e.g. `USDC`. */
  assetCode: string;
  /** `G...` address of the asset's issuer. */
  assetIssuer: string;
  /** Balance held in this trustline, at Horizon's 7-decimal precision. */
  balance: string;
  /** Maximum balance this trustline accepts. */
  limit: string;
}

/**
 * An account's balance, sequence number, subentry count and trustlines,
 * assembled from a single Horizon account request.
 */
export interface AccountSummary {
  address: string;
  /** Native XLM balance at Horizon's 7-decimal precision. */
  balanceXlm: string;
  sequence: string;
  /**
   * Ledger subentries the account owns (trustlines, offers, data entries,
   * signers). Mirrors Horizon's `subentry_count`.
   */
  subentryCount: number;
  /** Credit-asset trustlines. Liquidity-pool share balances are not included. */
  trustlines: AccountTrustline[];
}

/** Horizon's own shape for "this account has never been funded". */
const HORIZON_NOT_FOUND = 404;

/** Horizon's asset types for credit assets, i.e. trustline balances. */
const CREDIT_ASSET_TYPES = new Set(['credit_alphanum4', 'credit_alphanum12']);

interface HorizonBalance {
  asset_type: string;
  balance: string;
  limit?: string;
  asset_code?: string;
  asset_issuer?: string;
}

interface HorizonAccountResponse {
  balances?: HorizonBalance[];
  sequence: string;
  subentry_count?: number;
}

/** An account that Horizon positively reports as existing. */
function unfundedAccount(address: string): AccountInfo {
  return { address, balanceXLM: '0', sequenceNumber: '0', isActive: false };
}

/**
 * Fetches and parses one account from Horizon. Shared by every account helper
 * so they all get the same retry, timeout and error classification.
 *
 * Returns `null` when Horizon answers `404` (the account does not exist yet).
 */
async function fetchHorizonAccount(
  address: string,
  network: StellarNetwork,
  retry: ApiRetryConfig | undefined,
  horizonUrl: string | undefined,
  timeoutMs: number | undefined,
  operation: string,
): Promise<HorizonAccountResponse | null> {
  assertStellarAddress(address, 'address');
  const effectiveHorizonUrl = horizonUrl ?? getNetworkConfig(network).horizonUrl;

  let response: Response | null;
  try {
    response = await withTransientRetry(
      async () => {
        const res = await fetchWithTimeout(
          `${effectiveHorizonUrl}/accounts/${encodeURIComponent(address)}`,
          undefined,
          timeoutMs,
          operation,
        );
        if (res.ok) return res;

        // A 404 is an answer, not a failure: the account genuinely does not
        // exist yet. Everything else is left to the shared classifier, which
        // retries 429/5xx and rejects other 4xx without a second attempt.
        if (res.status === HORIZON_NOT_FOUND) {
          return null;
        }
        throw new TrustFlowError(
          `Horizon rejected the account lookup for ${address} (HTTP ${res.status})`,
          res.status >= 500 ? 'CONNECTION_ERROR' : 'NOT_FOUND',
          {
            status: res.status,
            'retry-after': res.headers.get('retry-after'),
          },
        );
      },
      undefined,
      retry,
      operation,
    );
  } catch (e) {
    // A transport failure reaches here only once the retry budget is spent.
    // Surface it as a typed SDK error so callers never have to distinguish a
    // raw `TypeError: fetch failed` from a real "account not found".
    throw TrustFlowError.wrap(e, 'CONNECTION_ERROR');
  }

  if (response === null) {
    return null;
  }

  try {
    return (await response.json()) as HorizonAccountResponse;
  } catch (e) {
    throw new TrustFlowError(
      `Horizon returned an unparseable account payload for ${address}`,
      'CONNECTION_ERROR',
      e,
    );
  }
}

/**
 * Fetches an account's balance and sequence number from Horizon.
 *
 * ### Retry behaviour
 *
 * Transport errors, timeouts, `429` and `5xx` are retried with capped,
 * jittered exponential backoff (`ApiRetryConfig`, passed through by
 * `TrustFlowClient.getAccountInfo`). Any other `4xx` fails immediately.
 *
 * ### Timeouts
 *
 * `timeoutMs` bounds the raw `fetch` to Horizon; the request is aborted at
 * the deadline and the failure surfaces as a `TIMEOUT` `TrustFlowError`
 * (retried like any other transient failure while the budget lasts). It
 * defaults to the SDK-wide 10s when omitted.
 *
 * ### Why this can now throw
 *
 * It previously swallowed *every* failure and returned `isActive: false`, so a
 * two-second Horizon outage was indistinguishable from an account that had
 * never been funded — callers showed "account not active" and prompted users to
 * fund an account that already had money. Now:
 *
 * - invalid address → throws `TrustFlowError` `VALIDATION_ERROR` before a request
 * - `404` → `isActive: false` (the genuine "does not exist" case)
 * - any other `4xx` → throws `TrustFlowError` `NOT_FOUND`
 * - transport error / `5xx` / timeout after retries → throws `TrustFlowError`
 *   `CONNECTION_ERROR`, or `TIMEOUT` when the deadline fired
 *
 * @param address - Stellar `G...` public key
 * @param network - Stellar network to query
 * @param retry - Optional retry budget; defaults to
 *   {@link import('../utils/node-retry').DEFAULT_NODE_RETRY_CONFIG}
 * @param horizonUrl - Optional Horizon base URL override
 * @param timeoutMs - Optional request timeout in milliseconds
 * @returns The account's balance, sequence number and activation state
 * @throws {TrustFlowError} `VALIDATION_ERROR` for an invalid address,
 *   `NOT_FOUND` for a non-`404` client error, `CONNECTION_ERROR` when Horizon
 *   stays unreachable, or `TIMEOUT` when the deadline fires
 *
 * @example
 * ```typescript
 * const info = await fetchAccountInfo('G…', 'TESTNET');
 * if (!info.isActive) console.log('not funded yet');
 * ```
 */
export async function fetchAccountInfo(
  address: string,
  network: StellarNetwork,
  retry?: ApiRetryConfig,
  horizonUrl?: string,
  timeoutMs?: number,
): Promise<AccountInfo> {
  const data = await fetchHorizonAccount(
    address,
    network,
    retry,
    horizonUrl,
    timeoutMs,
    'horizon.fetchAccountInfo',
  );
  if (data === null) {
    return unfundedAccount(address);
  }

  const xlm = data.balances?.find((b) => b.asset_type === 'native');
  return {
    address,
    balanceXLM: xlm?.balance ?? '0',
    sequenceNumber: data.sequence,
    isActive: true,
  };
}

/**
 * Fetches an account's balance, sequence number, subentry count and
 * trustlines from a **single** Horizon account request.
 *
 * Shares the retry, timeout and error rules of {@link fetchAccountInfo}, with
 * one difference: a `404` is an error here, because a summary of an account
 * that does not exist has no meaning.
 *
 * @param address - Stellar `G...` public key
 * @param network - Stellar network to query
 * @param retry - Optional retry budget
 * @param horizonUrl - Optional Horizon base URL override
 * @param timeoutMs - Optional request timeout in milliseconds
 * @returns The account summary
 * @throws {TrustFlowError} `ACCOUNT_NOT_FOUND` when Horizon reports no such
 *   account, `VALIDATION_ERROR` for an invalid address, `NOT_FOUND` for other
 *   `4xx`, `CONNECTION_ERROR` when Horizon stays unreachable, or `TIMEOUT`
 *
 * @example
 * ```typescript
 * const summary = await fetchAccountSummary('G…', 'TESTNET');
 * console.log(summary.balanceXlm, summary.subentryCount, summary.trustlines.length);
 * ```
 */
export async function fetchAccountSummary(
  address: string,
  network: StellarNetwork,
  retry?: ApiRetryConfig,
  horizonUrl?: string,
  timeoutMs?: number,
): Promise<AccountSummary> {
  const data = await fetchHorizonAccount(
    address,
    network,
    retry,
    horizonUrl,
    timeoutMs,
    'horizon.fetchAccountSummary',
  );
  if (data === null) {
    throw new TrustFlowError(
      `No account exists for ${address} on ${network}; it has not been funded yet`,
      'ACCOUNT_NOT_FOUND',
      undefined,
      'address',
    );
  }

  let balanceXlm = '0';
  const trustlines: AccountTrustline[] = [];
  for (const balance of data.balances ?? []) {
    if (balance.asset_type === 'native') {
      balanceXlm = balance.balance;
    } else if (CREDIT_ASSET_TYPES.has(balance.asset_type)) {
      trustlines.push({
        assetCode: balance.asset_code ?? '',
        assetIssuer: balance.asset_issuer ?? '',
        balance: balance.balance,
        limit: balance.limit ?? '0',
      });
    }
  }

  return {
    address,
    balanceXlm,
    sequence: data.sequence,
    subentryCount: data.subentry_count ?? 0,
    trustlines,
  };
}

/** Public friendbot endpoint that funds accounts on Stellar testnet. */
export const TESTNET_FRIENDBOT_URL = 'https://friendbot.stellar.org';

/** Options for {@link fundTestnetAccount}. */
export interface FundTestnetAccountOptions {
  /** Friendbot base URL. Defaults to {@link TESTNET_FRIENDBOT_URL}. */
  friendbotUrl?: string;
  /** Request timeout in milliseconds. Defaults to the SDK-wide 10s. */
  timeoutMs?: number;
}

/**
 * Outcome of {@link fundTestnetAccount}. Both outcomes leave the account
 * holding testnet XLM, so neither is an error.
 */
export type FundTestnetAccountResult =
  | { status: 'funded'; hash: string | undefined }
  | { status: 'already_funded' };

/** Friendbot result codes that mean the account already exists. */
const FRIENDBOT_ALREADY_EXISTS_CODES = ['op_already_exists', 'createAccountAlreadyExist'];

/**
 * Funds a Stellar testnet account through friendbot, idempotently.
 *
 * Friendbot rejects an account that already exists. This helper reads that
 * rejection as success and resolves `{ status: 'already_funded' }`, so calling
 * it twice for the same account does not throw. Every other failure (network
 * errors, rate limits, other HTTP errors) still throws.
 *
 * Testnet only: the public friendbot does not run on mainnet.
 *
 * @param address - Stellar `G...` public key to fund
 * @param options - Optional friendbot URL and request timeout
 * @returns `funded` with the transaction hash when friendbot created the
 *   account, or `already_funded` when the account already existed
 * @throws {TrustFlowError} `VALIDATION_ERROR` for an invalid address, `TIMEOUT`
 *   when the deadline fires, `CONNECTION_ERROR` for any other failure
 *
 * @example
 * ```typescript
 * const first = await fundTestnetAccount(publicKey);   // { status: 'funded', hash }
 * const again = await fundTestnetAccount(publicKey);   // { status: 'already_funded' }
 * ```
 */
export async function fundTestnetAccount(
  address: string,
  options: FundTestnetAccountOptions = {},
): Promise<FundTestnetAccountResult> {
  assertStellarAddress(address, 'address');
  const baseUrl = options.friendbotUrl ?? TESTNET_FRIENDBOT_URL;
  const url = `${baseUrl}?addr=${encodeURIComponent(address)}`;

  let response: Response;
  let body: string;
  try {
    response = await fetchWithTimeout(
      url,
      undefined,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'friendbot.fundTestnetAccount',
    );
    body = await response.text();
  } catch (e) {
    throw TrustFlowError.wrap(e, 'CONNECTION_ERROR');
  }

  if (response.ok) {
    return { status: 'funded', hash: parseFriendbotHash(body) };
  }
  if (FRIENDBOT_ALREADY_EXISTS_CODES.some((code) => body.includes(code))) {
    return { status: 'already_funded' };
  }
  throw new TrustFlowError(
    `Friendbot could not fund ${address} (HTTP ${response.status})`,
    'CONNECTION_ERROR',
    { status: response.status },
  );
}

/** Reads the transaction hash from a friendbot success body, or `undefined` if absent. */
function parseFriendbotHash(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { hash?: unknown };
    return typeof parsed.hash === 'string' ? parsed.hash : undefined;
  } catch {
    return undefined;
  }
}

/** Result of {@link previewNewAccount}: the public key and nothing else. */
export interface AccountPreview {
  /** `G...` public key of the generated account. */
  publicKey: string;
}

/**
 * Generates a new account for display and returns only its public key.
 *
 * The keypair is created and used inside this call and is never returned, so
 * the secret cannot reach the caller through the result. Use this only for a
 * preview. If the account is going to be used, generate a `Keypair` directly
 * and store its secret, because this helper cannot give it back.
 *
 * JavaScript strings cannot be overwritten, so this does not erase the secret
 * from memory. It only makes sure no reference to the secret is returned.
 *
 * @returns An object holding the generated account's public key
 *
 * @example
 * ```typescript
 * const { publicKey } = previewNewAccount();
 * showAddressToUser(publicKey);
 * ```
 */
export function previewNewAccount(): AccountPreview {
  const keypair = Keypair.random();
  return { publicKey: keypair.publicKey() };
}
