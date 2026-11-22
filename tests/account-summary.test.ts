import { fetchAccountSummary } from '../src/stellar/account';
import { TrustFlowClient } from '../src/client';

const CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const ALICE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const ISSUER = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFDAGORAC526G22TYOXA2';
const TESTNET_HORIZON = 'https://horizon-testnet.stellar.org';
const FAST = { retries: 2, retryDelayMs: 1, maxRetryDelayMs: 1 };

/** A minimal fetch Response stand-in, matching the shape used by horizon-retry tests. */
function respond(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const fullAccount = {
  sequence: '987654321',
  subentry_count: 3,
  balances: [
    { asset_type: 'native', balance: '42.5000000' },
    {
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: ISSUER,
      balance: '10.0000000',
      limit: '1000.0000000',
    },
    {
      asset_type: 'credit_alphanum12',
      asset_code: 'LONGASSET001',
      asset_issuer: ISSUER,
      balance: '0.0000000',
      limit: '922337203685.4775807',
    },
    {
      asset_type: 'liquidity_pool_shares',
      liquidity_pool_id: 'abc123',
      balance: '5.0000000',
      limit: '100.0000000',
    },
  ],
};

describe('fetchAccountSummary', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('returns balance, sequence, subentry count and credit trustlines from one request', async () => {
    fetchMock.mockResolvedValue(respond(200, fullAccount));

    await expect(fetchAccountSummary(ALICE, 'TESTNET', FAST)).resolves.toEqual({
      address: ALICE,
      balanceXlm: '42.5000000',
      sequence: '987654321',
      subentryCount: 3,
      trustlines: [
        {
          assetCode: 'USDC',
          assetIssuer: ISSUER,
          balance: '10.0000000',
          limit: '1000.0000000',
        },
        {
          assetCode: 'LONGASSET001',
          assetIssuer: ISSUER,
          balance: '0.0000000',
          limit: '922337203685.4775807',
        },
      ],
    });
    // Single underlying Horizon request, as the issue requires.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${TESTNET_HORIZON}/accounts/${ALICE}`);
  });

  it('defaults subentryCount and trustlines when Horizon omits them', async () => {
    fetchMock.mockResolvedValue(
      respond(200, { sequence: '1', balances: [{ asset_type: 'native', balance: '1.0000000' }] }),
    );

    await expect(fetchAccountSummary(ALICE, 'TESTNET', FAST)).resolves.toEqual({
      address: ALICE,
      balanceXlm: '1.0000000',
      sequence: '1',
      subentryCount: 0,
      trustlines: [],
    });
  });

  it('throws ACCOUNT_NOT_FOUND for an unfunded account instead of returning a placeholder', async () => {
    fetchMock.mockResolvedValue(respond(404, { status: 404 }));

    await expect(fetchAccountSummary(ALICE, 'TESTNET', FAST)).rejects.toMatchObject({
      name: 'TrustFlowError',
      code: 'ACCOUNT_NOT_FOUND',
      field: 'address',
    });
    // A 404 is a definitive answer, so it must not be retried.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 503 and then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(503, { status: 503 }))
      .mockResolvedValueOnce(respond(200, fullAccount));

    await expect(fetchAccountSummary(ALICE, 'TESTNET', FAST)).resolves.toMatchObject({
      subentryCount: 3,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports a persistent outage as CONNECTION_ERROR, never as a missing account', async () => {
    fetchMock.mockRejectedValue(new TypeError('failed to fetch'));

    await expect(fetchAccountSummary(ALICE, 'TESTNET', FAST)).rejects.toMatchObject({
      code: 'CONNECTION_ERROR',
    });
  });

  it('rejects an invalid address before making a request', async () => {
    await expect(fetchAccountSummary('not-an-address', 'TESTNET', FAST)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('TrustFlowClient.getAccountSummary', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('summarises the active account', async () => {
    fetchMock.mockResolvedValue(respond(200, fullAccount));
    const client = new TrustFlowClient({
      contractId: CONTRACT,
      retry: FAST,
      accounts: [{ address: ALICE }],
    });

    const summary = await client.getAccountSummary();
    expect(summary.address).toBe(ALICE);
    expect(summary.balanceXlm).toBe('42.5000000');
    expect(summary.trustlines).toHaveLength(2);
  });

  it('keeps ACCOUNT_NOT_FOUND rather than wrapping it as a connection error', async () => {
    fetchMock.mockResolvedValue(respond(404, { status: 404 }));
    const client = new TrustFlowClient({
      contractId: CONTRACT,
      retry: FAST,
      accounts: [{ address: ALICE }],
    });

    await expect(client.getAccountSummary()).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_FOUND',
    });
    // The client's own retry wrapper must not re-fetch a definitive 404.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('wraps a persistent transport failure as CONNECTION_ERROR', async () => {
    fetchMock.mockRejectedValue(new TypeError('failed to fetch'));
    const client = new TrustFlowClient({
      contractId: CONTRACT,
      retry: FAST,
      accounts: [{ address: ALICE }],
    });

    await expect(client.getAccountSummary()).rejects.toMatchObject({
      code: 'CONNECTION_ERROR',
    });
  });
});
