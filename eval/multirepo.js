#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { openDb } from '../src/store.js';
import { indexRepo } from '../src/indexer.js';
import { markdownTable, runQueries } from './lib.js';

/**
 * Multi-repository benchmark.
 *
 * The point is to stop grading our own homework. Same harness, same budget, three
 * third-party codebases in three languages, questions written from their docs rather
 * than from the source.
 *
 *   1. git clone --depth 1 <repo> .corpus/<name>
 *   2. write eval/queries/<name>.jsonl  (query + expected file::symbol)
 *   3. node eval/multirepo.js [--reindex]
 *
 * Prints a markdown table ready for the README and writes eval/results.json.
 */

const here = dirname(fileURLToPath(import.meta.url));
const reindex = process.argv.includes('--reindex');
const corpusFlag = process.argv.indexOf('--corpus');
const corpusDir =
  corpusFlag !== -1 && process.argv[corpusFlag + 1]
    ? resolve(process.argv[corpusFlag + 1])
    : resolve(here, '..', '..', '.corpus');

/** @type {Array<{ repo: string, looks: string }>} */
const REPOS = [
  { repo: 'express', looks: 'JavaScript (CommonJS)' },
  { repo: 'zod', looks: 'TypeScript' },
  { repo: 'httpx', looks: 'Python' },
];

const runs = [];
const lines = [];

for (const { repo, looks } of REPOS) {
  const dir = join(corpusDir, repo);
  const queriesPath = join(here, 'queries', `${repo}.jsonl`);
  if (!existsSync(dir)) {
    lines.push(`skip ${repo}: clone it to .corpus/${repo}`);
    continue;
  }
  if (!existsSync(queriesPath)) {
    lines.push(`skip ${repo}: no eval/queries/${repo}.jsonl`);
    continue;
  }

  const dbPath = join(corpusDir, `${repo}.db`);
  if (reindex || !existsSync(dbPath)) {
    const started = Date.now();
    const result = await indexRepo({ root: dir, dbPath, fresh: true });
    lines.push(
      `indexed ${repo} (${looks}): ${result.stats.files} files, ${result.stats.chunks} chunks, ` +
        `${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
  }

  const db = openDb(dbPath);
  const queries = readFileSync(queriesPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .map((l) => JSON.parse(l));

  const result = runQueries(db, queries);
  runs.push({ repo, result });
  db.close();
}

if (lines.length) {
  console.error(lines.join('\n'));
  console.error('');
}

if (runs.length === 0) {
  console.error('No corpora available. Clone the repos into .corpus/ first.');
  process.exit(1);
}

console.log(markdownTable(runs));

writeFileSync(
  join(here, 'results.json'),
  `${JSON.stringify(
    runs.map(({ repo, result }) => ({ repo, ...result })),
    null,
    2,
  )}\n`,
);

const failed = runs.flatMap(({ repo, result: r }) =>
  r.rows.filter((row) => row.rank === '—').map((row) => `${repo}: ${row.query}`),
);
if (failed.length) {
  console.error('');
  console.error(`misses (${failed.length}):`);
  for (const f of failed) console.error(`  ${f}`);
}
