import { tokensForQuery } from './tokenize.js';

/**
 * Query layer.
 *
 * Ranking is deliberately split in two stages:
 *
 *   1. **Recall** — BM25 over FTS5 decides which ~200 chunks are worth considering.
 *   2. **Precision** — a hand-written reranker decides the order, because BM25 cannot
 *      tell `search` (the export) from `search` (a local variable), cannot tell a
 *      definition from a mention in a test, and rewards long chunks that repeat a
 *      rare word over short chunks that answer the whole question.
 *
 * Raw bm25 values span an order of magnitude, so any additive signal would be drowned
 * out. The lexical score is therefore normalised into a small band and the explicit
 * signals do the ordering.
 */

const CANDIDATES = 200;
const SYMBOL_CANDIDATES = 60;

/** Paths that hold secondary evidence: tests, benchmarks, docs, fixtures. */
const SECONDARY_PATH = /(^|\/)(tests?|__tests__|specs?|bench|benches|benchmark|benchmarks|docs?|examples?|fixtures?|treeshake|internal-types|integration|e2e|scripts)\//;

/**
 * Turn free text into an FTS5 MATCH expression.
 * Every term is prefix-matched and terms are OR-ed: a user typing "tokenize camelCase"
 * should still find a chunk called `splitIdentifiers` that only mentions camelCase.
 * @param {string[]} tokens
 */
export function buildMatch(tokens) {
  const terms = new Set();
  for (const t of tokens) {
    for (const variant of plurals(t)) {
      if (/^[a-z0-9_]+$/.test(variant)) terms.add(`${variant}*`);
    }
  }
  if (terms.size === 0) return null;
  return [...terms].join(' OR ');
}

/**
 * Poor man's stemmer, applied to the query side only.
 *
 * FTS5's unicode61 tokeniser does no stemming, so "directories" would never match the
 * identifier `isDirectory`. Prefix matching solves the easy half (plural/singular,
 * -ing/-ed); a real Porter stemmer is a later upgrade.
 * @param {string} term
 */
export function plurals(term) {
  const out = new Set([term]);
  if (term.endsWith('ies') && term.length > 5) out.add(`${term.slice(0, -3)}y`);
  if (term.endsWith('es') && term.length > 4) out.add(term.slice(0, -2));
  if (term.endsWith('s') && !term.endsWith('ss') && term.length > 3) out.add(term.slice(0, -1));
  if (term.endsWith('ing') && term.length > 6) out.add(term.slice(0, -3));
  if (term.endsWith('ed') && term.length > 5) out.add(term.slice(0, -2));
  return [...out];
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} query
 * @param {{ limit?: number, pathPrefix?: string }} [opts]
 */
export function search(db, query, opts = {}) {
  const limit = opts.limit ?? 8;
  const tokens = tokensForQuery(query);
  const match = buildMatch(tokens);
  if (!match) return [];

  // Stage 1a: the whole query, scored across all columns.
  const bodyRows = db.prepare(SELECT_SQL).all(match, CANDIDATES);

  // Stage 1b: the same terms restricted to the symbol column. Without this, a chunk
  // named exactly after the question can be pushed past the candidate cut-off by
  // hundreds of chunks that merely mention its words in prose.
  const symbolMatch = symbolsOnly(tokens);
  const symbolRows = symbolMatch
    ? db.prepare(SELECT_SQL).all(symbolMatch, SYMBOL_CANDIDATES)
    : [];

  /** @type {Map<number, any>} */
  const byId = new Map();
  for (const row of bodyRows) byId.set(Number(row.id), { row, viaSymbol: false });
  for (const row of symbolRows) {
    const id = Number(row.id);
    const existing = byId.get(id);
    if (existing) existing.viaSymbol = true;
    else byId.set(id, { row, viaSymbol: true });
  }

  const lowered = query.trim().toLowerCase();
  const candidates = [];
  for (const { row, viaSymbol } of byId.values()) {
    if (opts.pathPrefix && !row.path.startsWith(opts.pathPrefix)) continue;
    const signals = conceptCoverage(row, tokens);
    // A candidate that matches none of the question's concepts is a BM25 artefact.
    if (signals.bodyHits === 0 && signals.symbolHits === 0) continue;
    candidates.push({ row, viaSymbol, signals });
  }
  if (candidates.length === 0) return [];

  // Stage 2: normalise the lexical ordering into a 0..20 band, then add signals.
  const ranks = candidates.map((c) => Number(c.row.rank));
  const best = Math.min(...ranks);
  const worst = Math.max(...ranks);
  const span = worst - best || 1;

  const scored = candidates.map(({ row, viaSymbol, signals }) => {
    const lexical = ((worst - Number(row.rank)) / span) * 20;
    return {
      id: Number(row.id),
      path: row.path,
      symbol: row.symbol,
      parent: row.parent,
      kind: row.kind,
      startLine: Number(row.start_line),
      endLine: Number(row.end_line),
      signature: row.signature,
      doc: row.doc,
      body: row.body,
      tokens: Number(row.tokens),
      score: rerank({ row, tokens, lowered, lexical, viaSymbol, signals }),
    };
  });

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, limit);
}

const SELECT_SQL = `SELECT c.id, c.path, c.symbol, c.parent, c.kind, c.start_line, c.end_line,
              c.signature, c.doc, c.body, c.tokens, c.symbol_toks, c.body_toks,
              bm25(chunks_fts, 6.0, 2.0, 1.2, 1.0) AS rank
         FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.rowid
        WHERE chunks_fts MATCH ?
        ORDER BY rank
        LIMIT ?`;

/** `{symbol_toks} : (a* OR b*)` — an FTS5 column-restricted query. */
function symbolsOnly(tokens) {
  const terms = new Set();
  for (const t of tokens) for (const v of plurals(t)) if (/^[a-z0-9_]+$/.test(v)) terms.add(`${v}*`);
  if (terms.size === 0) return null;
  return `{symbol_toks} : (${[...terms].join(' OR ')})`;
}

/**
 * How many of the question's concepts a chunk contains, in its body and in its symbol.
 * Symbol tokens are few, so a prefix test is affordable there; it lets "accepted" meet
 * `acceptsEncodings`, which exact matching would miss.
 */
function conceptCoverage(row, tokens) {
  const bodyToks = new Set(String(row.body_toks || '').split(' ').filter(Boolean));
  const symbolToks = String(row.symbol_toks || '').split(' ').filter(Boolean);

  let bodyHits = 0;
  let symbolHits = 0;
  for (const t of tokens) {
    const variants = plurals(t);
    if (variants.some((v) => bodyToks.has(v))) bodyHits++;
    if (variants.some((v) => symbolToks.some((s) => s.startsWith(v) || v.startsWith(s)))) symbolHits++;
  }
  return { bodyHits, symbolHits, bodyToks, symbolToks };
}

/**
 * Signals that boost a candidate, in order of impact:
 *   - the symbol *is* the query, or contains it (an exact symbol match);
 *   - the symbol is a single word that appears in the query;
 *   - the chunk covers more of the question's concepts;
 *   - the parent class is named;
 *   - the query names a path segment;
 *   - product code beats tests and benchmarks; real bodies beat re-export lines.
 */
function rerank({ row, tokens, lowered, lexical, viaSymbol, signals }) {
  let score = lexical;

  const symbol = String(row.symbol).toLowerCase();
  const parent = (row.parent || '').toLowerCase();
  const path = String(row.path).toLowerCase();
  const n = Math.max(1, tokens.length);
  const lines = Number(row.end_line) - Number(row.start_line) + 1;
  // Re-export lines, aliases and single-line constants are rarely the answer to a
  // multi-concept question, and they should not collect symbol-identity credit.
  const trivial = lines < 2 || String(row.body).length < 80;

  if (symbol === lowered) score += 50;
  else if (lowered.length > 2 && symbol.includes(lowered)) score += 18;
  else if (signals.symbolToks.length === 1 && tokens.includes(symbol) && !trivial) score += 22;

  if (viaSymbol) score += 5;

  score += (signals.bodyHits / n) * 10;
  score += (signals.symbolHits / n) * 18;

  if (parent) {
    for (const t of tokens) {
      if (plurals(t).includes(parent)) {
        score += 8;
        break;
      }
    }
  }

  let pathHits = 0;
  for (const t of tokens) if (plurals(t).some((v) => path.includes(v))) pathHits++;
  score += Math.min(pathHits, 3) * 3;

  if (SECONDARY_PATH.test(path) && !/test|spec|bench|example|fixture/.test(lowered)) score -= 14;
  if (row.kind === 'test' && !/test|spec|should|expect|assert/.test(lowered)) score -= 12;

  // Mild preference for focused chunks: a 900-line chunk is usually a worse answer
  // than a 40-line one that matched just as well.
  score -= (Math.min(String(row.body).length, 20_000) / 20_000) * 1.5;
  return score;
}

/**
 * A short, human-readable excerpt around the first matching term.
 * @param {string} body
 * @param {string[]} tokens
 * @param {number} [width]
 */
export function snippet(body, tokens, width = 180) {
  if (!body) return '';
  const lower = body.toLowerCase();
  let at = -1;
  for (const t of tokens) {
    const idx = lower.indexOf(t);
    if (idx !== -1 && (at === -1 || idx < at)) at = idx;
  }
  if (at === -1) return body.slice(0, width).replace(/\s+/g, ' ').trim();

  const start = Math.max(0, at - 60);
  const end = Math.min(body.length, start + width);
  return `${start > 0 ? '…' : ''}${body.slice(start, end).replace(/\s+/g, ' ').trim()}${end < body.length ? '…' : ''}`;
}
