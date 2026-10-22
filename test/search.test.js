import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from '../test-support/build-index.js';
import { search, buildMatch, snippet } from '../src/search.js';
import { packResults } from '../src/pack.js';
import { tokensForQuery } from '../src/tokenize.js';

const FILES = {
  'src/tokenize.js': `export function splitWords(text) {
  return String(text).match(/[A-Za-z]+/g) || [];
}

export function tokensForIndex(text) {
  return splitWords(text).map((w) => w.toLowerCase());
}
`,
  'src/search.js': `export function search(db, query) {
  const tokens = tokensForQuery(query);
  return db.all(tokens);
}

export function rerank(row) {
  return -row.rank;
}
`,
  'docs/notes.py': `def parse_config(raw):
    """Parse a config blob."""
    return raw
`,
};

test('exact symbol queries rank the symbol first', () => {
  const db = buildIndex(FILES);
  const results = search(db, 'rerank');
  assert.ok(results.length > 0);
  assert.equal(results[0].symbol, 'rerank');
});

test('natural-language query reaches a camelCase symbol', () => {
  const db = buildIndex(FILES);
  const results = search(db, 'split words by case');
  assert.ok(
    results.some((r) => r.symbol === 'splitWords'),
    `expected splitWords, got ${results.map((r) => r.symbol).join(', ')}`,
  );
});

test('path filter is applied before returning', () => {
  const db = buildIndex(FILES);
  const results = search(db, 'parse', { pathPrefix: 'docs/' });
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.path.startsWith('docs/')));
});

test('empty query returns nothing instead of everything', () => {
  const db = buildIndex(FILES);
  assert.deepEqual(search(db, '   '), []);
});

test('builds a prefix OR match expression', () => {
  assert.equal(buildMatch(['token', 'index']), 'token* OR index*');
  assert.equal(buildMatch([]), null);
});

test('snippet centres on the first matching term', () => {
  const text = 'a'.repeat(120) + ' needle ' + 'b'.repeat(400);
  const out = snippet(text, ['needle'], 80);
  assert.ok(out.includes('needle'));
  assert.ok(out.length < 140);
});

test('packer respects the token budget and reports omissions', () => {
  const results = Array.from({ length: 6 }, (_, i) => ({
    path: `src/f${i}.js`,
    symbol: `fn${i}`,
    parent: null,
    kind: 'function',
    startLine: 1,
    endLine: 40,
    signature: `function fn${i}() {`,
    body: `function fn${i}() {\n${'  const x = 1;\n'.repeat(39)}}`,
    score: 10 - i,
  }));
  const packed = packResults(results, { budgetTokens: 200 });
  assert.ok(packed.includes('fn0'));
  assert.ok(packed.includes('omitted'));
  assert.ok(packed.length < 2600, 'packed output should stay near the budget');
});
