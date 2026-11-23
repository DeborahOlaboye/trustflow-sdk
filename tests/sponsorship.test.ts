import { Keypair } from '@stellar/stellar-sdk';
import { buildSponsoredAccountOperations } from '../src/stellar/sponsorship';

describe('buildSponsoredAccountOperations', () => {
  const sponsor = Keypair.random().publicKey();
  const newAccount = Keypair.random().publicKey();

  it('builds begin, create and end operations in the required order', () => {
    const ops = buildSponsoredAccountOperations({ sponsor, newAccount });

    expect(ops.map((op) => op.body().switch().name)).toEqual([
      'beginSponsoringFutureReserves',
      'createAccount',
      'endSponsoringFutureReserves',
    ]);
  });

  it('returns exactly three operations', () => {
    expect(buildSponsoredAccountOperations({ sponsor, newAccount })).toHaveLength(3);
  });

  it('rejects a sponsor that is also the new account', () => {
    expect(() => buildSponsoredAccountOperations({ sponsor, newAccount: sponsor })).toThrow();
  });

  it('rejects an invalid sponsor address', () => {
    expect(() => buildSponsoredAccountOperations({ sponsor: 'bad', newAccount })).toThrow();
  });

  it('rejects an invalid new account address', () => {
    expect(() => buildSponsoredAccountOperations({ sponsor, newAccount: 'bad' })).toThrow();
  });
});
