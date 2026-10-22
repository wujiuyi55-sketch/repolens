/**
 * Identifier-aware tokenizer.
 *
 * Code search fails with generic word split for two reasons:
 *   - `getUserById` is one token, so a query for "user by id" never matches;
 *   - `body` and `bodies` are different words, so stemming-ish prefix matching matters.
 *
 * We therefore split identifiers on camelCase / snake_case / kebab-case boundaries and
 * index the resulting words. Queries run through the same function, which makes the
 * two sides symmetric — the single most important property of a retrieval index.
 */

const STOPWORDS = new Set(
  ('a an the of to in on at by for from with without into onto and or not no is are was were be been ' +
    'being it its this that these those as if else then than so such do does did done has have had ' +
    'will would can could should may might must we you they he she i me my our your their there here ' +
    'when where why how what which who whom whose all any both each few more most other some only own ' +
    'same too very just now new get set use used using').split(' '),
);

const IDENT_START = /[A-Za-z_$]/;

/**
 * Split arbitrary text into lowercase words, honouring identifier casing.
 * @param {string} text
 * @returns {string[]}
 */
export function splitWords(text) {
  const words = [];
  const raw = String(text);

  // First pass: keep identifier-ish runs, drop punctuation.
  const runs = raw.match(/[A-Za-z0-9_$]+/g) || [];

  for (const run of runs) {
    if (!run) continue;
    // camelCase / PascalCase, including acronym runs (HTTPServer -> HTTP Server).
    const spaced = run
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/[_$]+/g, ' ');
    for (const part of spaced.split(/\s+/)) {
      if (!part) continue;
      const lower = part.toLowerCase();
      if (lower.length < 2 || lower.length > 40) continue;
      words.push(lower);
    }
  }
  return words;
}

/**
 * Tokenize for indexing: dedupe, keep stopwords out (they add noise and cost disk).
 * @param {string} text
 * @returns {string[]}
 */
export function tokensForIndex(text) {
  const seen = new Set();
  const out = [];
  for (const w of splitWords(text)) {
    if (STOPWORDS.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

/**
 * Tokenize a user query. Same vocabulary as the index, order preserved.
 * @param {string} text
 * @returns {string[]}
 */
export function tokensForQuery(text) {
  const seen = new Set();
  const out = [];
  for (const w of splitWords(text)) {
    if (STOPWORDS.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

/**
 * Rough token estimate used for budgeting context windows.
 * English prose is ~4 chars/token; source code is closer to 3.2.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 3.6);
}

export { STOPWORDS, IDENT_START };
