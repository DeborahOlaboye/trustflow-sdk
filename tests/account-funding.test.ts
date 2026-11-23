import {
  fundTestnetAccount,
  previewNewAccount,
  TESTNET_FRIENDBOT_URL,
} from '../src/stellar/account';

const ALICE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** A minimal fetch Response stand-in with a text body, as friendbot returns. */
function respond(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body,
  } as unknown as Response;
}

describe('fundTestnetAccount', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('funds a new account and returns the transaction hash', async () => {
    fetchMock.mockResolvedValue(respond(200, JSON.stringify({ hash: 'abc123' })));

    await expect(fundTestnetAccount(ALICE)).resolves.toEqual({
      status: 'funded',
      hash: 'abc123',
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`${TESTNET_FRIENDBOT_URL}?addr=${ALICE}`);
  });

  it('resolves already_funded when friendbot reports op_already_exists', async () => {
    fetchMock.mockResolvedValue(
      respond(400, JSON.stringify({ result_codes: { operations: ['op_already_exists'] } })),
    );

    await expect(fundTestnetAccount(ALICE)).resolves.toEqual({ status: 'already_funded' });
  });

  it('resolves already_funded for the createAccountAlreadyExist result name', async () => {
    fetchMock.mockResolvedValue(respond(400, 'createAccountAlreadyExist'));

    await expect(fundTestnetAccount(ALICE)).resolves.toEqual({ status: 'already_funded' });
  });

  it('is idempotent: a second call for the same account does not throw', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(200, JSON.stringify({ hash: 'abc123' })))
      .mockResolvedValueOnce(respond(400, 'op_already_exists'));

    await expect(fundTestnetAccount(ALICE)).resolves.toMatchObject({ status: 'funded' });
    await expect(fundTestnetAccount(ALICE)).resolves.toEqual({ status: 'already_funded' });
  });

  it('still throws for a genuine friendbot failure', async () => {
    fetchMock.mockResolvedValue(respond(500, 'internal error'));

    await expect(fundTestnetAccount(ALICE)).rejects.toMatchObject({
      code: 'CONNECTION_ERROR',
    });
  });

  it('still throws when the network request itself fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(fundTestnetAccount(ALICE)).rejects.toMatchObject({
      code: 'CONNECTION_ERROR',
    });
  });

  it('rejects an invalid address before making a request', async () => {
    await expect(fundTestnetAccount('not-a-key')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses a custom friendbot URL when one is given', async () => {
    fetchMock.mockResolvedValue(respond(200, '{}'));

    await fundTestnetAccount(ALICE, { friendbotUrl: 'http://localhost:8000/friendbot' });

    expect(fetchMock.mock.calls[0][0]).toBe(`http://localhost:8000/friendbot?addr=${ALICE}`);
  });
});

describe('previewNewAccount', () => {
  it('returns only a public key, with no secret reference', () => {
    const preview = previewNewAccount();

    expect(Object.keys(preview)).toEqual(['publicKey']);
    expect(preview.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
  });

  it('generates a different account on each call', () => {
    expect(previewNewAccount().publicKey).not.toBe(previewNewAccount().publicKey);
  });
});
