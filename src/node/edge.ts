/**
 * Runtime-safe stand-in for the `@trustflow/sdk/node` entry.
 *
 * `package.json` routes the `workerd`, `edge-light` and `browser` export
 * conditions here instead of `./dist/node/index.*`. Edge runtimes (Cloudflare
 * Workers, Vercel Edge) and browser bundles therefore never resolve
 * `node:http` / `node:https`, so the failure is a clear
 * `UNSUPPORTED_ENVIRONMENT` `TrustFlowError` at the call site rather than a
 * bundler error such as `Can't resolve 'node:crypto'` (#776).
 *
 * The environment-agnostic helpers (`DEFAULT_POOL_CONFIG`, `getHttpAgentStats`,
 * `monitorPoolHealth`, `destroyPoolAgent`) are re-exported unchanged, since the
 * root entry already ships them everywhere. Only the factories that build
 * Node `http`/`https` agents throw.
 *
 * The factories throw when called rather than at import time on purpose:
 * `sideEffects` is `false`, so a module-level throw could be tree-shaken away
 * and would not be reliable.
 */
import { TrustFlowError } from '../errors';

export type {
  PoolConfig,
  PoolStats,
  PooledAgent,
  PoolMonitorConfig,
} from '../utils/connection-pool';
export {
  DEFAULT_POOL_CONFIG,
  getHttpAgentStats,
  monitorPoolHealth,
  destroyPoolAgent,
} from '../utils/connection-pool';
export { TrustFlowError } from '../errors';

/**
 * Throws the explanatory `UNSUPPORTED_ENVIRONMENT` error for a Node-only API.
 *
 * @param api - Name of the Node-only function that was called
 * @throws {TrustFlowError} always, with code `UNSUPPORTED_ENVIRONMENT`
 */
function nodeOnly(api: string): never {
  throw new TrustFlowError(
    `${api} needs the Node.js runtime (it uses node:http / node:https), and ` +
      `'@trustflow/sdk/node' is not available in Edge, Workers or browser bundles. ` +
      `Call it from a Node.js server process instead. The root '@trustflow/sdk' ` +
      `entry works in this runtime.`,
    'UNSUPPORTED_ENVIRONMENT',
  );
}

/**
 * Node-only. Throws in this runtime; see the module comment.
 *
 * @throws {TrustFlowError} `UNSUPPORTED_ENVIRONMENT` in Edge, Workers and browsers
 */
export function createHttpAgent(): never {
  return nodeOnly('createHttpAgent');
}

/**
 * Node-only. Throws in this runtime; see the module comment.
 *
 * @throws {TrustFlowError} `UNSUPPORTED_ENVIRONMENT` in Edge, Workers and browsers
 */
export function createHttpsAgent(): never {
  return nodeOnly('createHttpsAgent');
}

/**
 * Node-only. Throws in this runtime; see the module comment.
 *
 * @throws {TrustFlowError} `UNSUPPORTED_ENVIRONMENT` in Edge, Workers and browsers
 */
export function configureAxiosConnectionPool(): never {
  return nodeOnly('configureAxiosConnectionPool');
}
