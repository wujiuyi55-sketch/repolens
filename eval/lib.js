import { search } from '../src/search.js';
import { packResults } from '../src/pack.js';
import { tokensForQuery, estimateTokens } from '../src/tokenize.js';

/**
 * Shared evaluation logic.
 *
 * Two numbers matter for a code-search tool, and they trade off against each other:
 *   1. Did the right declaration make the top-k? (recall / MRR)
 *   2. How many tokens did the answer cost? (context efficiency)
 *
 * The baseline is what an agent does today without an index: grep for the terms, then
 * read every file that matched. We approximate "read the file" as the sum of the token
 * counts of all its chunks, capped at 5 files — beyond that a reasonable agent gives
 * up and greps again.
 */

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<{ query: string, expect: [string, string] }>} queries
 * @param {{ limit?: number, budgetTokens?: number }} [opts]
 */
export function runQueries(db, queries, opts = {}) {
  const limit = opts.limit ?? 5;
  const budgetTokens = opts.budgetTokens ?? 1200;

  const fileTotals = new Map(
    db
      .prepare('SELECT file_id, SUM(tokens) AS t FROM chunks GROUP BY file_id')
      .all()
      .map((r) => [Number(r.file_id), Number(r.t)]),
  );

  let top1 = 0;
  let top5 = 0;
  let reciprocal = 0;
  let packedSum = 0;
  let baselineSum = 0;
  const rows = [];

  for (const q of queries) {
    const results = search(db, q.query, { limit });
    const rank = results.findIndex((r) => r.path === q.expect[0] && r.symbol === q.expect[1]);
    const hitAt5 = rank >= 0;

    if (rank === 0) top1++;
    if (hitAt5) top5++;
    reciprocal += hitAt5 ? 1 / (rank + 1) : 0;

    const packedTokens = estimateTokens(packResults(results, { budgetTokens }));
    const baselineTokens = baselineCost(db, fileTotals, q.query);

    packedSum += packedTokens;
    baselineSum += baselineTokens;

    rows.push({
      query: q.query,
      expect: `${q.expect[1]} (${q.expect[0]})`,
      rank: hitAt5 ? rank + 1 : '—',
      packed: packedTokens,
      baseline: baselineTokens,
    });
  }

  const n = queries.length;
  return {
    rows,
    n,
    top1: n ? top1 / n : 0,
    top5: n ? top5 / n : 0,
    mrr: n ? reciprocal / n : 0,
    packedAvg: n ? Math.round(packedSum / n) : 0,
    baselineAvg: n ? Math.round(baselineSum / n) : 0,
    saving: baselineSum ? 1 - packedSum / baselineSum : 0,
  };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Map<number, number>} fileTotals
 * @param {string} query
 */
export function baselineCost(db, fileTotals, query) {
  const tokens = tokensForQuery(query).filter((t) => t.length > 2);
  if (tokens.length === 0) return 0;

  const where = tokens.map(() => 'body LIKE ?').join(' OR ');
  const params = tokens.map((t) => `%${t}%`);
  const files = db.prepare(`SELECT DISTINCT file_id FROM chunks WHERE ${where} LIMIT 5`).all(...params);

  let sum = 0;
  for (const f of files) sum += fileTotals.get(Number(f.file_id)) ?? 0;
  return sum;
}

/**
 * Markdown table for the README.
 * @param {Array<{ repo: string, result: ReturnType<typeof runQueries> }>} runs
 */
export function markdownTable(runs) {
  const lines = [
    '| repository | queries | top-1 | top-5 | MRR | tokens/answer | grep+read | saving |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const { repo, result } of runs) {
    lines.push(
      `| ${repo} | ${result.n} | ${pct(result.top1)} | ${pct(result.top5)} | ${result.mrr.toFixed(3)} | ` +
        `${result.packedAvg} | ${result.baselineAvg} | ${pct(result.saving)} |`,
    );
  }

  const total = runs.reduce(
    (acc, { result }) => {
      acc.n += result.n;
      acc.top1 += result.top1 * result.n;
      acc.top5 += result.top5 * result.n;
      acc.mrr += result.mrr * result.n;
      acc.packed += result.packedAvg * result.n;
      acc.baseline += result.baselineAvg * result.n;
      return acc;
    },
    { n: 0, top1: 0, top5: 0, mrr: 0, packed: 0, baseline: 0 },
  );

  if (runs.length > 1) {
    lines.push(
      `| **all** | ${total.n} | ${pct(total.top1 / total.n)} | ${pct(total.top5 / total.n)} | ` +
        `${(total.mrr / total.n).toFixed(3)} | ${Math.round(total.packed / total.n)} | ` +
        `${Math.round(total.baseline / total.n)} | ${pct(1 - total.packed / total.baseline)} |`,
    );
  }
  return lines.join('\n');
}

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}
