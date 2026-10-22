#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDb, getMeta } from '../src/store.js';

/**
 * Chunk coverage report.
 *
 * A retrieval tool is only as good as its chunker: if 40% of a file is never inside
 * any chunk, no query can ever return it. This tool answers "which files did I fail to
 * understand?" by measuring the fraction of non-blank lines covered by at least one
 * chunk. Run it after every chunker change; it is the regression signal that tests
 * cannot give you on third-party code.
 *
 *   node tools/coverage.js .repolens/index.db [--top 20] [--min 90]
 */

const args = process.argv.slice(2);
const dbPath = resolve(args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) ?? '.repolens/index.db');
const top = Number(flag('--top') ?? 15);
const min = Number(flag('--min') ?? 0);
const minLines = Number(flag('--min-lines') ?? 15);
const prefix = flag('--prefix');

const db = openDb(dbPath);
const root = getMeta(db).root;

/** @param {string} name */
function flag(name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

if (!root) {
  console.error('Index has no recorded root; rebuild it with `repolens index`.');
  process.exit(1);
}

const files = db.prepare('SELECT id, path, lines FROM files ORDER BY path').all();
const chunkStmt = db.prepare('SELECT start_line, end_line FROM chunks WHERE file_id = ?');

let totalCode = 0;
let totalCovered = 0;
/** @type {Array<{ path: string, code: number, covered: number, pct: number }>} */
const report = [];

for (const file of files) {
  const abs = join(root, file.path);
  let text;
  try {
    text = await readFile(abs, 'utf8');
  } catch {
    continue;
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  const covered = new Uint8Array(lines.length + 1);
  for (const chunk of chunkStmt.all(file.id)) {
    for (let l = Number(chunk.start_line); l <= Number(chunk.end_line); l++) covered[l] = 1;
  }

  let code = 0;
  let hit = 0;
  for (let l = 1; l <= lines.length; l++) {
    if (!lines[l - 1].trim()) continue;
    code++;
    if (covered[l]) hit++;
  }
  if (code === 0) continue;

  totalCode += code;
  totalCovered += hit;
  if (code >= minLines && (!prefix || file.path.startsWith(prefix))) {
    report.push({ path: file.path, code, covered: hit, pct: (hit / code) * 100 });
  }
}

report.sort((a, b) => a.pct - b.pct);

const overall = totalCode === 0 ? 0 : (totalCovered / totalCode) * 100;
console.log(`files           ${report.length}`);
console.log(`code lines      ${totalCode}`);
console.log(`covered lines   ${totalCovered}`);
console.log(`coverage        ${overall.toFixed(1)}%`);
console.log('');
console.log(`worst ${top} files${min ? ` (below ${min}%)` : ''}:`);
for (const row of report.filter((r) => r.pct < min || !min).slice(0, top)) {
  console.log(`  ${row.pct.toFixed(0).padStart(4)}%  ${String(row.code).padStart(5)} lines  ${row.path}`);
}
