#!/usr/bin/env node
'use strict';

/**
 * `npx @trustflow/sdk init` writes a starter Node project into the current
 * directory (#779):
 *
 *   trustflow.config.mjs     client settings read from the environment
 *   trustflow-quickstart.mjs connect + create-escrow example
 *   .env.example             every variable the two files above read
 *
 * Existing files are never overwritten silently. When a target already exists
 * the command lists it and asks first. Without a terminal it refuses, and
 * `--force` is the only way to overwrite non-interactively.
 *
 * Only Node built-ins are used, so the command runs before any project setup.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CONFIG_FILE = 'trustflow.config.mjs';
const QUICKSTART_FILE = 'trustflow-quickstart.mjs';
const ENV_FILE = '.env.example';

/** File name → contents. The env template must list every variable the other files read. */
const TEMPLATES = {
  [CONFIG_FILE]: [
    '// TrustFlow SDK client settings, read from the environment.',
    '// Copy .env.example to .env and fill it in. The SDK does not load .env itself:',
    "// use Node's --env-file flag, dotenv, or your framework's env loading.",
    '',
    'export const trustflowConfig = {',
    "  network: process.env.STELLAR_NETWORK || 'TESTNET',",
    '  contractId: process.env.TRUSTFLOW_CONTRACT_ID,',
    '  rpcUrl: process.env.SOROBAN_RPC_URL || undefined,',
    '  horizonUrl: process.env.HORIZON_URL || undefined,',
    '};',
    '',
  ].join('\n'),

  [QUICKSTART_FILE]: [
    "import { TrustFlowClient } from '@trustflow/sdk';",
    "import { createEscrow } from '@trustflow/sdk/escrow';",
    "import { xlmToStroops } from '@trustflow/sdk/utils';",
    "import { trustflowConfig } from './trustflow.config.mjs';",
    '',
    'if (!trustflowConfig.contractId) {',
    "  throw new Error('TRUSTFLOW_CONTRACT_ID is not set. Copy .env.example to .env and fill it in.');",
    '}',
    '',
    'const sender = process.env.STELLAR_PUBLIC_KEY;',
    'const recipient = process.env.RECIPIENT_ADDRESS;',
    'if (!sender || !recipient) {',
    "  throw new Error('Set STELLAR_PUBLIC_KEY and RECIPIENT_ADDRESS in your .env file.');",
    '}',
    '',
    'const client = new TrustFlowClient(trustflowConfig);',
    'await client.connect();',
    '',
    'const escrow = await createEscrow(client, {',
    '  sender,',
    '  recipient,',
    "  amountStroops: xlmToStroops('50'),",
    '  durationBlocks: 1000,',
    '});',
    "console.log('Created escrow:', escrow.id);",
    '',
  ].join('\n'),

  [ENV_FILE]: [
    '# TrustFlow SDK environment. Copy to .env and fill in the values.',
    '',
    '# Required: the TrustFlow escrow contract ID (starts with C).',
    'TRUSTFLOW_CONTRACT_ID=',
    '# Optional: TESTNET (default), MAINNET or LOCAL.',
    'STELLAR_NETWORK=TESTNET',
    '# Optional: Soroban RPC and Horizon URLs. Leave empty to use the network defaults.',
    'SOROBAN_RPC_URL=',
    'HORIZON_URL=',
    '# Used by trustflow-quickstart.mjs: the sender (G...) and the escrow payee (G...).',
    'STELLAR_PUBLIC_KEY=',
    'RECIPIENT_ADDRESS=',
    '',
  ].join('\n'),
};

const USAGE = [
  'Usage: npx @trustflow/sdk init [--force]',
  '',
  'Writes a starter TrustFlow project into the current directory:',
  `  ${CONFIG_FILE}, ${QUICKSTART_FILE}, ${ENV_FILE}`,
  '',
  '  --force   overwrite existing files without asking',
].join('\n');

/**
 * Lists each template file and whether it already exists in `targetDir`.
 *
 * @param {string} targetDir - Directory the files will be written to
 * @param {Record<string, string>} [templates] - File name → contents
 * @returns {Array<{ name: string, file: string, exists: boolean }>}
 */
function planScaffold(targetDir, templates = TEMPLATES) {
  return Object.keys(templates).map((name) => {
    const file = path.join(targetDir, name);
    return { name, file, exists: fs.existsSync(file) };
  });
}

/**
 * Writes every planned file. Call only after the overwrite decision is made.
 *
 * @param {Array<{ name: string, file: string }>} plan - Output of {@link planScaffold}
 * @param {Record<string, string>} [templates] - File name → contents
 */
function writeScaffold(plan, templates = TEMPLATES) {
  for (const entry of plan) {
    fs.writeFileSync(entry.file, templates[entry.name], 'utf8');
  }
}

/**
 * Asks a yes/no question on the terminal. Anything other than `y` or `yes`
 * counts as no.
 *
 * @param {string} question - Prompt text
 * @returns {Promise<boolean>}
 */
function askConfirmation(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/**
 * Runs `init`. Resolves to the process exit code.
 *
 * @param {string[]} args - Arguments after `init`
 * @param {object} [options] - Overrides for tests
 * @returns {Promise<number>} `0` when files were written, `1` otherwise
 */
async function runInit(args, options = {}) {
  const {
    cwd = process.cwd(),
    templates = TEMPLATES,
    confirm = askConfirmation,
    interactive = Boolean(process.stdin.isTTY),
    log = console.log,
    error = console.error,
  } = options;

  const force = args.includes('--force');
  const plan = planScaffold(cwd, templates);
  const existing = plan.filter((entry) => entry.exists).map((entry) => entry.name);

  if (existing.length > 0 && !force) {
    if (!interactive) {
      error(
        `Refusing to overwrite existing files: ${existing.join(', ')}. ` +
          'Re-run with --force to overwrite them, or run in a terminal to confirm.',
      );
      return 1;
    }
    const approved = await confirm(
      `These files already exist and will be overwritten: ${existing.join(', ')}\nOverwrite them? (y/N) `,
    );
    if (!approved) {
      log('Nothing was written.');
      return 1;
    }
  }

  writeScaffold(plan, templates);
  for (const entry of plan) log(`  wrote ${entry.name}`);
  log(
    `Next: copy ${ENV_FILE} to .env, set TRUSTFLOW_CONTRACT_ID, then run: node ${QUICKSTART_FILE}`,
  );
  return 0;
}

/**
 * Dispatches the CLI arguments.
 *
 * @param {string[]} argv - Arguments without the node and script paths
 * @param {object} [options] - Passed through to {@link runInit}
 * @returns {Promise<number>} Exit code
 */
async function main(argv, options = {}) {
  const [command, ...rest] = argv;
  if (command === 'init') return runInit(rest, options);

  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  if (command === undefined || command === '--help' || command === '-h') {
    log(USAGE);
    return 0;
  }
  error(`Unknown command: ${command}\n\n${USAGE}`);
  return 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}

module.exports = { TEMPLATES, planScaffold, writeScaffold, runInit, main };
