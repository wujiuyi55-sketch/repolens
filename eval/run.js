#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { openDb } from '../src/store.js';
import { runQueries } from './lib.js';

/**
 * Single-corpus evaluation: one index, one query file, one table.
 *
 *   node eval/run.js .repolens/index.db eval/queries.jsonl
 *
 * For the multi-repository benchmark see eval/multirepo.js.
 */

const here = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const minFlag = args.indexOf('--min-top5');
const minTop5 = minFlag === -1 ? 0 : Number(args[minFlag + 1]);
const positional = args.filter((a, i) => !a.startsWith('--') && i !== minFlag + 1);

const dbPath = resolve(positional[0] ?? join(here, '..', '.repolens', 'index.db'));
const queriesPath = resolve(positional[1] ?? join(here, 'queries.jsonl'));

const db = openDb(dbPath);
const queries = readQueries(queriesPath);
const result = runQueries(db, queries);

printTable(result.rows);
console.log('');
console.log(`queries      ${result.n}`);
console.log(`top-1        ${pct(result.top1)}`);
console.log(`top-5        ${pct(result.top5)}`);
console.log(`MRR          ${result.mrr.toFixed(3)}`);
console.log(`tokens       ${result.packedAvg} avg per answer (baseline ${result.baselineAvg})`);
console.log(`saving       ${pct(result.saving)} fewer tokens to reach an answer`);

if (minTop5 > 0 && result.top5 + 1e-9 < minTop5) {
  process.stderr.write(`\nFAIL: top-5 ${pct(result.top5)} is below the required ${pct(minTop5)}\n`);
  process.exit(1);
}

/** @param {string} file */
function readQueries(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .map((l) => JSON.parse(l));
}

/** @param {Array<{ query: string, expect: string, rank: number|string, packed: number, baseline: number }>} rows */
function printTable(rows) {
  const widths = [46, 34, 5, 8, 9];
  console.log(formatRow(['query', 'expected symbol', 'rank', 'tokens', 'grep+read'], widths));
  console.log(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const r of rows) {
    console.log(
      formatRow([r.query, r.expect, String(r.rank), String(r.packed), String(r.baseline)], widths),
    );
  }
  console.log(widths.map((w) => '─'.repeat(w)).join('  '));
}

function formatRow(cells, widths) {
  return cells.map((c, i) => truncate(String(c), widths[i]).padEnd(widths[i])).join('  ');
}

function truncate(s, w) {
  return s.length <= w ? s : `${s.slice(0, w - 1)}…`;
}

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}
