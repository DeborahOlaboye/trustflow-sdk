# Spike: Parallel transaction broadcast across several RPC endpoints

Tracking issue: [#769](https://github.com/trustflow-protocol/trustflow-sdk/issues/769)

**Status: source review complete, benchmark not run.** Claims marked **[source]** were checked against
this repository at the commit this document lands on. Claims marked **[vendor]** describe how Soroban
RPC and its providers are documented to behave and were **not** reproduced here. Claims marked **[live]**
need a testnet run against at least two RPC endpoints, which was **not** done for this document. Section 6
lists the exact runs that would settle the open questions.

## TL;DR

| Question | Answer |
|---|---|
| Does the pipeline broadcast to more than one endpoint today? | **No.** `TransactionPipeline` builds one `rpc.Server` from `client.rpcUrl` and sends every envelope through it. [source] |
| Is there a multi-endpoint layer that could be reused? | **Partly.** `NetworkManager` (`src/stellar/network.ts`) does round-robin and failover across RPC URLs, but nothing in `src/` imports it. [source] |
| Would parallel broadcast reduce latency? | **Unknown until measured.** No latency data exists in the repo, and this document does not invent numbers. [live] pending. |
| Is the complexity justified? | **Not yet, and not before two things are settled:** how a `DUPLICATE` or `ERROR` from one endpoint is read, and whether the bad-sequence recovery is safe when another endpoint has already accepted the envelope. See sections 3 and 4. |
| Recommendation | **Defer parallel broadcast.** Land the cheaper, lower-risk change first: stop treating a single endpoint's `ERROR` as final when the hash is already pending (section 5). Revisit parallel broadcast after the benchmark in section 6. |

## 1. Broadcast path today [source]

| Step | Location | Behaviour |
|---|---|---|
| One RPC client per pipeline | `src/tx-pipeline/pipeline.ts:253` | `new rpc.Server(client.rpcUrl, …)`. The URL comes from `ClientConfig.rpcUrl`, defaulting to `SOROBAN_RPC_URLS[network]`. |
| Send | `src/tx-pipeline/pipeline.ts:628` | `this.server.sendTransaction(tx)` inside `withRetry`, bounded by `client.timeoutMs`. |
| Terminal rejection | `pipeline.ts:630-636` | `status === 'ERROR'` throws `submissionFailed` with the node's `errorResult`. Not retried. |
| Deferred | `pipeline.ts:637-641` | `status === 'TRY_AGAIN_LATER'` is transient and is replayed. |
| Anything else | `pipeline.ts:643` | Falls through to `pollForConfirmation(hash)`. This covers `PENDING`, and also `DUPLICATE`, which has no explicit branch. |
| Confirmation | `pipeline.ts:855` onward | Polls `getTransaction(hash)` on the same single server until `SUCCESS`, `FAILED`, or the deadline. |
| Bad-sequence recovery | `pipeline.ts:53` (`BAD_SEQ_PATTERN`), `:736` | A `tx_bad_seq` rejection refreshes the cached sequence and rebuilds the envelope. |

Every envelope has one hash, and confirmation is keyed on that hash. Nothing in the pipeline depends on
which endpoint accepted the envelope. That matters for section 3.

## 2. Latency: what would be measured [source] / [live]

The repo contains no latency measurements, so nothing here is evidence. A fair comparison needs:

- The same signed envelope sent to two or more testnet RPC endpoints, both single-endpoint and parallel.
- Time from first send to `SUCCESS` from `getTransaction`, at p50, p90 and p99, over at least a few hundred
  runs. Tail latency is the stated motivation in the issue, so the p99 figure matters more than the mean.
- The same runs repeated at different times of day, because public endpoints vary.

**Not measured here.** Section 6 lists the commands.

## 3. Accepted by one endpoint, rejected by another [source] / [vendor]

This is the hardest part of the design, and the current code does not have a rule for it, because it only
ever talks to one endpoint.

- **Same hash, different answers.** A parallel send can produce `PENDING` or `DUPLICATE` from one endpoint
  and `ERROR` from another. The `ERROR` may be a real rejection (for example `tx_bad_seq` because the first
  copy already advanced the account's sequence), not a failure of the transaction.
  [source] the pipeline treats any `ERROR` as final (`pipeline.ts:630-636`), so a naive parallel version
  would report failure for a transaction that is about to confirm.
- **Proposed rule.** Decide by hash, not by the first answer. Treat `ERROR` as final only when no endpoint
  has reported the hash as `PENDING` or `DUPLICATE`. Otherwise, poll `getTransaction(hash)` on the endpoint
  that accepted it. [source] this matches how the pipeline already confirms by hash.
- **Bad-sequence recovery is the risky part.** [source] `pipeline.ts:736` rebuilds the envelope with a new
  sequence after `tx_bad_seq`. If one endpoint accepted the original and another reported `tx_bad_seq`,
  rebuilding would create a second valid transaction, and the two could both be in flight. The rebuild must
  first check whether the original hash has landed, and only rebuild when it has not.

## 4. Billing [vendor]

Providers differ. Some charge per request, and some cap requests per key. Parallel broadcast multiplies
`sendTransaction` calls by the number of endpoints, and `getTransaction` polling multiplies again if each
endpoint is polled. **This document did not check any provider's pricing.** Check the price page of each
RPC provider the integrator uses before enabling a parallel mode by default.

## 5. Recommended first change (low risk) [source]

Before parallel broadcast, make the single-endpoint path correct when a `DUPLICATE` comes back:

1. At `pipeline.ts:643`, `DUPLICATE` already falls through to polling. Add a test that pins this, so the
   behaviour cannot regress silently. [source] there is no test for it today.
2. Keep `ERROR` final, as it is now, for single-endpoint use.

This keeps the current guarantees and gives the parallel design its regression net.

## 6. Checks that would settle the open questions [live]

Not run. Each should be run on testnet, with the endpoints and the number of runs recorded in the PR:

1. **Latency.** Send the same envelope to two independent testnet RPC endpoints, single and parallel, for at
   least 300 runs each. Record p50, p90 and p99 time to `SUCCESS`.
2. **Duplicate handling.** Submit the same envelope to two endpoints and record each endpoint's `status`
   and `errorResult`. Confirm the hash-based rule in section 3.
3. **Bad sequence.** Advance the account's sequence through one endpoint, then send a stale envelope to
   the other. Confirm that the recovery rebuilds only when the original hash has not landed.
4. **Cost.** Count requests per confirmed transaction under each mode, and compare with each provider's
   quota.

## 7. Decision

- Do not ship parallel broadcast yet.
- Land the `DUPLICATE` regression test (section 5) on its own.
- Re-open the design once section 6 has numbers. The go/no-go rule: adopt parallel broadcast only if p99
  improves by a margin the team agrees on, and the duplicate and bad-sequence rules in section 3 are
  covered by tests.
