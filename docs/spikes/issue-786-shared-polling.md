# Spike: one shared `usePolling()` primitive for the hooks module

Tracking issue: [#786](https://github.com/trustflow-protocol/trustflow-sdk/issues/786)
(motivated by #783 and #784)

**Status: inventory done, primitive landed, proof of concept migrated.** Every claim here was
checked against the source at the commit this document lands on.

## TL;DR

| Question | Answer |
|---|---|
| How many polling hooks exist? | **None that poll data.** `src/hooks/` had one timer: `useWalletSession`'s 1 s clock tick. The hooks named in the motivating bugs, `useDisputeStatus` (#783) and `useMultiSigOperation` (#784), are not in `src/` or on any branch. |
| How many polling implementations exist overall? | **Seven timer loops**, all outside the hooks, in classes. None of them handles tab visibility, and only two avoid overlapping fetches. See section 1. |
| What should a shared primitive cover? | Stable references, visibility pause, no restart on new inline callbacks, no overlap, stale-result discard, a key that restarts, and a stop condition. See section 2. |
| Recommendation | **Use `usePolling` for every data-polling React hook from now on.** It has landed (`src/hooks/usePolling.ts`), and `useMultiSigOperation` is built on it as the proof of concept. Leave the class-based monitors alone; see section 3. |

## 1. Inventory

| # | Where | What it polls | Loop | Overlap guard | Visibility | Backoff | Stable data refs |
|---|---|---|---|---|---|---|---|
| 1 | `hooks/useWalletSession.ts:73` | Wall clock, for expiry and `isExpiringSoon` | `setInterval` 1 s | n/a (sync) | No | No | n/a |
| 2 | `stellar/monitor.ts:133` `AccountBalanceMonitor` | Account balance via `fetchFn` | `setInterval`, default 30 s | **Yes**: `checkNow` reuses the in-flight check | No | No | No (emits each cycle) |
| 3 | `escrow/monitor.ts:392` `EscrowMonitor.startPolling` | Events via `fetchFn` | `setInterval`, default 5 s | **No**: a slow `fetchFn` overlaps the next tick | No | No | n/a (dedups events) |
| 4 | `escrow/monitor.ts:431` `EscrowMonitor.startResilientPolling` | Events from a cursor | `setTimeout` chain | **Yes**: next tick scheduled after settle | No | **Yes**: exponential, capped 30 s | n/a |
| 5 | `stellar/network.ts:108` `NetworkManager` | RPC health | `setInterval` | No | No | No | n/a |
| 6 | `utils/connection-pool.ts:168` `monitorPoolHealth` | HTTP agent socket stats | `setInterval`, default 10 s | n/a (sync) | No | No | n/a |
| 7 | `tx-pipeline/pipeline.ts:855` `pollForConfirmation` | `getTransaction(hash)` until final | awaited loop | **Yes** (sequential) | No | Retry with backoff | n/a |

`auth/tokenRefresh.ts:147` (`TokenRefreshManager`) is a single scheduled refresh, not a poll, so it is
left out.

Observations:
- **Visibility handling exists nowhere** (#783's root cause). No `visibilitychange` listener in `src/`
  before this spike.
- **Overlap handling is inconsistent.** It's present in 2, 4 and 7 and missing in 3 and 5.
- **Referential stability exists nowhere** (#784's root cause). Every loop hands consumers new objects
  each cycle, and `MultiSigEscrowClient.exportState` builds a new `collectedSignatures` array on every
  call.

## 2. The primitive: `usePolling(fetchFn, options)`

```ts
const { data, error, loading, refresh } = usePolling(fetchFn, {
  interval,                // ms between the end of one fetch and the start of the next
  enabled = true,          // false: no fetch, no polling
  pauseWhenHidden = true,  // stop while the tab is hidden, fetch at once on show
  key,                     // restart and clear data when this changes (e.g. an id)
  stopWhen,                // (data) => boolean: stop at a final state
});
```

| Requirement | Why | How |
|---|---|---|
| Stable references | Memoised children must not re-render on unchanged polls (#784). | Results go through `replaceEqualDeep`, which reuses the previous object, and unchanged members inside a changed one. |
| Visibility pause | Background tabs must not keep polling (#783). | A `visibilitychange` listener clears the timer when hidden and runs an immediate fetch when shown. |
| No refetch loops | Inline callbacks and fresh options objects must not restart polling. | `fetchFn` and `stopWhen` are read through refs. Only `interval`, `enabled`, `pauseWhenHidden` and `key` restart it. |
| No overlap | A slow fetch must not stack up requests. | A `setTimeout` chain: the next fetch is scheduled after the previous one settles. |
| No stale writes | A fetch from before a restart or unmount must not overwrite newer state. | A generation counter; results from an older generation are dropped. |
| Changing target | Switching ids must not show the old id's data. | `key` clears data and restarts. |
| Final states | Polling must stop once nothing can change. | `stopWhen`. |

Out of scope for v1: backoff on errors. Only `startResilientPolling` needs it today, and it isn't a
hook. If a hook needs it later, add an `errorBackoff` option rather than reimplementing it.

## 3. Migration plan and risk

| Implementation | Migrate to `usePolling`? | Risk / effort |
|---|---|---|
| New data-polling hooks (`useMultiSigOperation`, and `useDisputeStatus` when it is written) | **Yes**: build them on it. | None, since they're new. `useMultiSigOperation` is the proof of concept in this change. |
| `useWalletSession` clock (1) | **No.** It is a clock tick, not a fetch. Moving it would add a pointless async fetch and visibility pausing would freeze the expiry check. A plain `setInterval` is the right tool. | n/a |
| `AccountBalanceMonitor`, `EscrowMonitor`, `NetworkManager`, `monitorPoolHealth`, `pollForConfirmation` (2–7) | **No.** These are framework-agnostic classes used from Node and the browser; a React hook can't replace them. A React wrapper should call `usePolling(() => monitor.checkNow(), …)` instead of re-polling. | Low. Separately, `EscrowMonitor.startPolling` (3) can overlap slow fetches. It's worth its own issue to switch it to the `setTimeout` chain that `startResilientPolling` already uses. |

## 4. What landed with this spike

- `src/hooks/usePolling.ts` and `src/hooks/structuralSharing.ts`, with tests in `tests/usePolling.test.ts`.
- `src/hooks/useMultiSigOperation.ts`, the proof of concept and the fix for #784, with tests in
  `tests/useMultiSigOperation.test.ts`. The tests include the issue's repro: a `React.memo` child does
  not re-render across unchanged polls.
