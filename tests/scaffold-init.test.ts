import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The scaffold is plain CommonJS with no build step, so it is loaded directly.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const scaffold = require('../bin/trustflow-sdk.js') as {
  TEMPLATES: Record<string, string>;
  planScaffold: (dir: string) => Array<{ name: string; file: string; exists: boolean }>;
  runInit: (args: string[], options?: Record<string, unknown>) => Promise<number>;
  main: (argv: string[], options?: Record<string, unknown>) => Promise<number>;
};

const root = path.resolve(__dirname, '..');
const CONFIG = 'trustflow.config.mjs';
const QUICKSTART = 'trustflow-quickstart.mjs';
const ENV = '.env.example';

/** Variable names declared (`NAME=`) in an env file. */
function envKeys(text: string): string[] {
  return [...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
}

describe('npx @trustflow/sdk init (#779)', () => {
  let dir: string;
  const quiet = { log: jest.fn(), error: jest.fn() };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trustflow-init-'));
    quiet.log.mockClear();
    quiet.error.mockClear();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes the config, quickstart and env template into an empty directory', async () => {
    const code = await scaffold.runInit([], { cwd: dir, interactive: false, ...quiet });

    expect(code).toBe(0);
    for (const name of [CONFIG, QUICKSTART, ENV]) {
      expect(fs.existsSync(path.join(dir, name))).toBe(true);
    }
  });

  it('writes a quickstart that imports the SDK entries the README documents', () => {
    const quickstart = scaffold.TEMPLATES[QUICKSTART]!;

    expect(quickstart).toContain("from '@trustflow/sdk';");
    expect(quickstart).toContain("from '@trustflow/sdk/escrow';");
    expect(quickstart).toContain("from '@trustflow/sdk/utils';");
    expect(quickstart).toContain('createEscrow(client');
  });

  it('keeps the generated env template in step with the repo .env.example', () => {
    const repoEnv = envKeys(fs.readFileSync(path.join(root, '.env.example'), 'utf8'));
    const generated = envKeys(scaffold.TEMPLATES[ENV]!);

    // Every variable the scaffold asks for must exist in the repo template.
    for (const key of generated) {
      expect(repoEnv).toContain(key);
    }
  });

  it('only reads environment variables that the env template declares', () => {
    const declared = envKeys(scaffold.TEMPLATES[ENV]!);
    const read = new Set<string>();
    for (const name of [CONFIG, QUICKSTART]) {
      for (const m of scaffold.TEMPLATES[name]!.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
        read.add(m[1]!);
      }
    }

    expect(read.size).toBeGreaterThan(0);
    for (const name of read) {
      expect(declared).toContain(name);
    }
  });

  it('requires the contract ID, the only config field the client cannot run without', () => {
    expect(scaffold.TEMPLATES[ENV]).toMatch(/^TRUSTFLOW_CONTRACT_ID=$/m);
    expect(scaffold.TEMPLATES[QUICKSTART]).toContain('TRUSTFLOW_CONTRACT_ID is not set');
  });

  it('refuses to overwrite an existing file when there is no terminal to confirm with', async () => {
    fs.writeFileSync(path.join(dir, ENV), 'MY_SECRET=keep-me\n');

    const code = await scaffold.runInit([], { cwd: dir, interactive: false, ...quiet });

    expect(code).toBe(1);
    expect(fs.readFileSync(path.join(dir, ENV), 'utf8')).toBe('MY_SECRET=keep-me\n');
    expect(fs.existsSync(path.join(dir, CONFIG))).toBe(false);
    expect(quiet.error.mock.calls[0]?.[0]).toMatch(/--force/);
  });

  it('writes nothing when the user declines the overwrite prompt', async () => {
    fs.writeFileSync(path.join(dir, CONFIG), 'original\n');
    const confirm = jest.fn().mockResolvedValue(false);

    const code = await scaffold.runInit([], { cwd: dir, interactive: true, confirm, ...quiet });

    expect(code).toBe(1);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toContain(CONFIG);
    expect(fs.readFileSync(path.join(dir, CONFIG), 'utf8')).toBe('original\n');
    expect(fs.existsSync(path.join(dir, QUICKSTART))).toBe(false);
  });

  it('overwrites existing files after the user confirms', async () => {
    fs.writeFileSync(path.join(dir, CONFIG), 'original\n');
    const confirm = jest.fn().mockResolvedValue(true);

    const code = await scaffold.runInit([], { cwd: dir, interactive: true, confirm, ...quiet });

    expect(code).toBe(0);
    expect(fs.readFileSync(path.join(dir, CONFIG), 'utf8')).toBe(scaffold.TEMPLATES[CONFIG]);
  });

  it('overwrites without asking when --force is passed', async () => {
    fs.writeFileSync(path.join(dir, ENV), 'old\n');
    const confirm = jest.fn();

    const code = await scaffold.runInit(['--force'], {
      cwd: dir,
      interactive: false,
      confirm,
      ...quiet,
    });

    expect(code).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(dir, ENV), 'utf8')).toBe(scaffold.TEMPLATES[ENV]);
  });

  it('plans which files already exist', () => {
    fs.writeFileSync(path.join(dir, QUICKSTART), '');

    const plan = scaffold.planScaffold(dir);
    expect(plan.find((p) => p.name === QUICKSTART)?.exists).toBe(true);
    expect(plan.find((p) => p.name === CONFIG)?.exists).toBe(false);
  });

  it('prints usage for --help and fails on an unknown command', async () => {
    await expect(scaffold.main(['--help'], quiet)).resolves.toBe(0);
    expect(quiet.log.mock.calls[0]?.[0]).toContain('npx @trustflow/sdk init');

    await expect(scaffold.main(['deploy'], quiet)).resolves.toBe(1);
    expect(quiet.error.mock.calls[0]?.[0]).toContain('Unknown command: deploy');
  });
});
