# Spike: Sponsored reserves for onboarding without pre-funding

Tracking issue: [#775](https://github.com/trustflow-protocol/trustflow-sdk/issues/775)

**Status: design and offline prototype done, testnet run pending.** The operation builder is in
`src/stellar/sponsorship.ts` and has unit tests, but it has **not** been submitted to testnet. Claims
marked **[source]** were checked against this repository. Claims marked **[vendor]** describe the Stellar
protocol (CAP-33 sponsored reserves) as documented, and were **not** re-checked against a live network.
Claims marked **[live]** need a testnet run, listed in section 5.

## TL;DR

| Question | Answer |
|---|---|
| What would `createSponsoredAccount()` look like? | Pure builder: returns three operations (begin, create with `0` balance, end). The caller puts them in one transaction whose source is the sponsor, then signs with both keys. Shipped as `buildSponsoredAccountOperations` (section 2). [source] |
| Who carries the ongoing obligation? | **The sponsor.** It pays the base reserve for the new account for as long as that account exists, and it can revoke the sponsorship later. [vendor] The SDK should state this in the API docs and not hide it. |
| Does this remove onboarding friction completely? | **No.** The new account starts with `0` XLM. It cannot pay fees for its own transactions, so the sponsor still needs to pay fees (for example through a fee-bump) until the account is funded. [vendor] This limits what "no pre-funding" means. |
| Patterns in other SDKs? | The stellar-sdk already exposes the three operations (`Operation.beginSponsoringFutureReserves`, `Operation.createAccount`, `Operation.endSponsoringFutureReserves`), which the prototype uses. [source] Other wallets' flows were not surveyed for this document. |

## 1. Research question: API shape

The Stellar protocol needs a sponsor/sponsee pair. The sponsor opens the sponsorship, the account is
created inside it, and the sponsored account closes it. Stellar requires the **sponsored account** to sign
the closing operation, so a sponsored create is **not** a single-signature action from the sponsor's side.
[vendor]

The prototype is therefore a builder that returns operations, not a function that submits a transaction:

```typescript
const ops = buildSponsoredAccountOperations({ sponsor: sponsorPublicKey, newAccount: newPublicKey });
// Caller: build a transaction with source = sponsor, add ops in order, then
//   tx.sign(sponsorKeypair, newAccountKeypair);
```

Why a builder rather than a full `createSponsoredAccount()`: the SDK already separates building from
signing and submitting (the pipeline in `src/tx-pipeline`). A builder fits that split, and it lets the
caller choose the fee, the timeout and whether to fee-bump. A later `createSponsoredAccount()` can wrap
it once the testnet run in section 5 has settled how fees behave.

Validation in the prototype [source]: both addresses must be valid `G...` keys, and the sponsor and new
account must differ. Both are checked before any operation is built.

## 2. Operation details [source] / [vendor]

| Index | Operation | Source | Purpose |
|---|---|---|---|
| 0 | `beginSponsoringFutureReserves(sponsoredId = newAccount)` | sponsor | Names the account whose reserves the sponsor will pay. |
| 1 | `createAccount(destination = newAccount, startingBalance = '0')` | sponsor | Creates the account. A `0` balance is only valid inside a sponsorship. [vendor] |
| 2 | `endSponsoringFutureReserves()` | **newAccount** | Closes the sponsorship. The sponsored account must issue it. [vendor] |

The order matters. Operation 2 is only valid after 0 and 1 inside the same transaction.

## 3. Ongoing obligations and how the SDK should expose them

The sponsor's risk is the part the issue asks us to surface:

1. **Reserve cost.** The sponsor pays the base reserve for the new account's ledger entries. Those entries
   include the account itself and any trustlines or offers the account later creates while sponsored.
   [vendor] The reserve stays locked for as long as the account exists.
2. **Revocation.** The sponsor can later revoke the sponsorship. The reserve then moves onto the sponsored
   account, which must hold enough XLM to cover it. If it does not, the revoke fails. [vendor] So a sponsor
   that walks away does not free up the cost. It has to be handled explicitly.
3. **Fees are not covered.** The new account's own transactions are charged to their source account, so
   the account needs XLM for fees once it acts on its own. [vendor] The sponsor can cover this by fee-bumping
   the account's transactions.

Proposed SDK behaviour, to be written into the API docs when the API ships:

- Name the sponsor as the party that carries the reserve, in the JSDoc of any sponsored-creation helper.
- Return the reserve amount that the sponsor is committing, so an integrator can show it.
- Keep revocation out of the first version. It can be added once a real integrator needs it, and until then
  the docs should point at the Stellar revoke operation.

## 4. Test coverage in this change [source]

`tests/sponsorship.test.ts` checks that the builder returns the three operations in the required order,
and that it rejects a sponsor equal to the new account and any invalid address. It does not submit anything,
so it proves the shape of the operations, not that the network accepts them.

## 5. Checks that would finish the spike [live]

Not run. Each should be run on testnet and recorded in the PR:

1. Create a sponsor account with friendbot (`fundTestnetAccount`, same change), then call
   `buildSponsoredAccountOperations` with a fresh `Keypair.random()` as the new account.
2. Build the transaction with source = sponsor, sign it with both keys, and submit it. Record the result
   code, and check that the new account exists with a `0` balance.
3. Confirm that the new account cannot send a transaction until it has XLM or a sponsor covers its fee.
4. Revoke the sponsorship from the sponsor side, and record whether it fails when the new account holds no XLM.
5. Record the actual reserve the sponsor pays, by reading the sponsor's `balanceXlm` and `subentryCount`
   through `fetchAccountSummary` before and after step 2.

## 6. Decision

- Ship the builder as a prototype. It is correct by construction against the documented operation order, but
  the testnet run in section 5 is the gate before any helper that submits transactions is added.
- Document the sponsor's obligations in the API docs before the API is promoted from prototype.
