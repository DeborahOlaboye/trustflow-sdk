import { Operation, type xdr } from '@stellar/stellar-sdk';
import { TrustFlowError } from '../errors';
import { assertStellarAddress } from '../utils/validation';

/** Inputs for {@link buildSponsoredAccountOperations}. */
export interface SponsoredAccountInput {
  /**
   * `G...` address that pays the new account's base reserve. It is the source
   * of the transaction and must sign it.
   */
  sponsor: string;
  /**
   * `G...` address of the account to create. It holds no XLM yet and must
   * sign the transaction, because Stellar requires the sponsored account to
   * close the sponsorship itself.
   */
  newAccount: string;
}

/**
 * Builds the three operations that create `newAccount` with its base reserve
 * paid by `sponsor` (CAP-33 sponsored account creation):
 *
 * 1. `beginSponsoringFutureReserves` (source: sponsor) names `newAccount` as
 *    the account whose reserves the sponsor will pay.
 * 2. `createAccount` (source: sponsor) creates `newAccount` with a `0` starting
 *    balance, which is only valid inside a sponsorship.
 * 3. `endSponsoringFutureReserves` (source: `newAccount`) ends the sponsorship.
 *    Stellar requires this operation to come from the sponsored account.
 *
 * Assemble the operations into one transaction whose source is the sponsor,
 * then sign it with both the sponsor and `newAccount`. The sponsor keeps paying
 * the reserve for as long as `newAccount` exists. See
 * `docs/spikes/issue-775-sponsored-reserves.md` for the trade-offs.
 *
 * @param input - Sponsor and new account addresses
 * @returns The three operations, in the order they must appear in the transaction
 * @throws {TrustFlowError} `VALIDATION_ERROR` for an invalid address, or when
 *   the sponsor and new account are the same
 *
 * @example
 * ```typescript
 * const ops = buildSponsoredAccountOperations({ sponsor, newAccount });
 * const tx = new TransactionBuilder(sponsorAccount, { fee, networkPassphrase })
 *   .addOperation(...)  // add each op in order
 *   .setTimeout(30)
 *   .build();
 * tx.sign(sponsorKeypair, newAccountKeypair);
 * ```
 */
export function buildSponsoredAccountOperations(input: SponsoredAccountInput): xdr.Operation[] {
  assertStellarAddress(input.sponsor, 'sponsor');
  assertStellarAddress(input.newAccount, 'newAccount');
  if (input.sponsor === input.newAccount) {
    throw TrustFlowError.validation('newAccount', 'must differ from sponsor');
  }

  return [
    Operation.beginSponsoringFutureReserves({
      sponsoredId: input.newAccount,
      source: input.sponsor,
    }),
    Operation.createAccount({
      destination: input.newAccount,
      startingBalance: '0',
      source: input.sponsor,
    }),
    Operation.endSponsoringFutureReserves({
      source: input.newAccount,
    }),
  ];
}
