#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { indexStats, openDb } from './store.js';
import { indexRepo, defaultDbPath } from './indexer.js';
import { search } from './search.js';
import { packResults } from './pack.js';
import { startMcpServer } from './mcp.js';

const USAGE = `repolens — structure-aware code retrieval for AI agents

Usage:
  repolens index [root] [--db <file>] [--fresh]   Build or refresh the index
  repolens search "<query>" [--db <file>] [-n 8]  Query from the terminal
  repolens mcp [--db <file>]                      Serve MCP over stdio
  repolens stats [--db <file>]                    Show index coverage

Options:
  --db <file>   Index file (default: <root>/.repolens/index.db)
  --fresh       Ignore existing index and rebuild from scratch
  -n <count>    Number of results for "search" (default 8)
  --budget <n>  Token budget for "search" output (default 1600)
`;

/**
 * @param {string[]} argv
 */
async function main(argv) {
  const [command, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);

  if (!command || command === '-h' || command === '--help') {
    process.stdout.write(USAGE);
    return;
  }

  if (command === 'index') {
    const root = resolve(positional[0] ?? '.');
    const dbPath = resolve(typeof flags.db === 'string' && flags.db ? flags.db : defaultDbPath(root));
    await runIndex({ root, dbPath, fresh: Boolean(flags.fresh) });
    return;
  }

  if (command === 'search') {
    const dbPath = resolveDb(flags.db, positional[0] ?? '.');
    const query = positional.join(' ').trim();
    if (!query) fail('Provide a query, e.g. repolens search "bm25 ranking"');
    const db = requireDb(dbPath);
    const results = search(db, query, { limit: Number(flags.n ?? 8) });
    if (results.length === 0) {
      process.stdout.write(`No match for "${query}".\n`);
      return;
    }
    process.stdout.write(`${packResults(results, { budgetTokens: Number(flags.budget ?? 1600) })}\n`);
    return;
  }

  if (command === 'mcp') {
    const dbPath = resolveDb(flags.db, positional[0] ?? '.');
    const db = requireDb(dbPath);
    await startMcpServer({ db });
    return;
  }

  if (command === 'stats') {
    const dbPath = resolveDb(flags.db, positional[0] ?? '.');
    printStats(requireDb(dbPath));
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
  process.exitCode = 1;
}

/**
 * @param {{ root: string, dbPath: string, fresh: boolean }} opts
 */
async function runIndex({ root, dbPath, fresh }) {
  const result = await indexRepo({
    root,
    dbPath,
    fresh,
    onProgress: ({ files }) => {
      if (files % 100 === 0) process.stderr.write(`  indexed ${files} files…\n`);
    },
  });

  if (result.scanned === 0) {
    process.stderr.write(`No indexable source files under ${root}\n`);
    process.exitCode = 1;
    return;
  }

  const seconds = (result.ms / 1000).toFixed(1);
  process.stderr.write(
    `Indexed ${result.changed} files (${result.unchanged} unchanged, ${result.skipped} skipped), ` +
      `${result.chunks} chunks in ${seconds}s → ${dbPath}\n`,
  );
  printStats(openDb(dbPath));
}

/** @param {import('node:sqlite').DatabaseSync} db */
function printStats(db) {
  const s = indexStats(db);
  const langs = s.langs.map((l) => `${l.lang} ${l.files}`).join(', ') || '—';
  const kinds = s.kinds.map((k) => `${k.kind} ${k.chunks}`).join(', ') || '—';
  process.stdout.write(
    [
      `files      ${s.files}`,
      `chunks     ${s.chunks}`,
      `bytes      ${s.sourceBytes}`,
      `languages  ${langs}`,
      `kinds      ${kinds}`,
      '',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  /** @type {string[]} */
  const positional = [];
  /** @type {Record<string, string|boolean>} */
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fresh') flags.fresh = true;
    else if (arg === '--db') flags.db = argv[++i];
    else if (arg === '-n' || arg === '--limit') flags.n = argv[++i];
    else if (arg === '--budget') flags.budget = argv[++i];
    else if (arg.startsWith('--db=')) flags.db = arg.slice(5);
    else positional.push(arg);
  }
  return { positional, flags };
}

/**
 * @param {string|boolean|undefined} flag
 * @param {string} root
 */
function resolveDb(flag, root) {
  if (typeof flag === 'string' && flag) return resolve(flag);
  return resolve(join(root, '.repolens', 'index.db'));
}

/** @param {string} dbPath */
function requireDb(dbPath) {
  if (!existsSync(dbPath)) {
    fail(`No index at ${dbPath}. Run: repolens index <root>`);
  }
  return openDb(dbPath);
}

/** @param {string} message */
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
});
