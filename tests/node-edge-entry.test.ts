import * as fs from 'fs';
import * as path from 'path';
import * as edge from '../src/node/edge';
import * as nodeEntry from '../src/node';
import { TrustFlowError } from '../src/errors';

/**
 * #776: `@trustflow/sdk/node` used to fail in Edge and Workers with a bundler
 * error about `node:crypto`. Those runtimes now resolve a stub that throws a
 * clear `UNSUPPORTED_ENVIRONMENT` error when a Node-only factory is called.
 */

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  exports: Record<string, Record<string, string>>;
};

/** Returns whatever `fn` throws, so the error's fields can be asserted. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the function to throw');
}

describe('@trustflow/sdk/node export routing (#776)', () => {
  const node = pkg.exports['./node']!;

  it.each(['workerd', 'edge-light', 'browser'])(
    'routes the %s condition to the runtime-safe stub',
    (condition) => {
      expect(node[condition]).toBe('./dist/node/edge.mjs');
    },
  );

  it('keeps the real Node entry for plain Node imports and requires', () => {
    expect(node.import).toBe('./dist/node/index.mjs');
    expect(node.require).toBe('./dist/node/index.js');
    expect(node.types).toBe('./dist/node/index.d.ts');
  });

  it('builds the stub as its own tsup entry, so the dist file exists', () => {
    const tsup = fs.readFileSync(path.join(root, 'tsup.config.ts'), 'utf8');
    expect(tsup).toContain("'src/node/edge.ts'");
  });

  it('keeps the stub free of node:http and node:https imports', () => {
    const source = fs.readFileSync(path.join(root, 'src/node/edge.ts'), 'utf8');
    expect(source).not.toMatch(/from\s+['"](node:)?https?['"]/);
  });
});

describe('edge stub behaviour', () => {
  it.each<[string, () => unknown]>([
    ['createHttpAgent', () => edge.createHttpAgent()],
    ['createHttpsAgent', () => edge.createHttpsAgent()],
    ['configureAxiosConnectionPool', () => edge.configureAxiosConnectionPool()],
  ])('%s throws UNSUPPORTED_ENVIRONMENT and names the call and the fix', (name, call) => {
    const error = thrownBy(call);

    expect(error).toBeInstanceOf(TrustFlowError);
    expect((error as TrustFlowError).code).toBe('UNSUPPORTED_ENVIRONMENT');
    expect((error as TrustFlowError).message).toContain(name);
    expect((error as TrustFlowError).message).toContain("'@trustflow/sdk'");
  });

  it('re-exports the runtime-agnostic pool helpers unchanged', () => {
    expect(edge.DEFAULT_POOL_CONFIG).toEqual(nodeEntry.DEFAULT_POOL_CONFIG);
    expect(edge.getHttpAgentStats).toBe(nodeEntry.getHttpAgentStats);
    expect(edge.monitorPoolHealth).toBe(nodeEntry.monitorPoolHealth);
    expect(edge.destroyPoolAgent).toBe(nodeEntry.destroyPoolAgent);
  });

  it('exposes the same TrustFlowError class as the rest of the SDK', () => {
    expect(edge.TrustFlowError).toBe(TrustFlowError);
  });
});
