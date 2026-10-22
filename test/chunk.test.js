import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkFile } from '../src/chunk.js';

const SAMPLE = `/** Add two numbers. */
export function add(a, b) {
  return a + b;
}

export class Store {
  constructor(deps) {
    this.deps = deps;
  }

  async load(id) {
    return this.deps.get(id);
  }
}

export const makeStore = (deps) => new Store(deps);

export type Id = string;
`;

test('finds top-level declarations, in source order', () => {
  const chunks = chunkFile({ relPath: 'sample.ts', text: SAMPLE, lang: 'ts' });
  assert.deepEqual(
    chunks.map((c) => c.symbol),
    ['add', 'Store', 'constructor', 'load', 'makeStore', 'Id'],
  );
});

test('records accurate line ranges', () => {
  const chunks = chunkFile({ relPath: 'sample.ts', text: SAMPLE, lang: 'ts' });
  const add = chunks.find((c) => c.symbol === 'add');
  assert.equal(add.startLine, 2);
  assert.equal(add.endLine, 4);
  const load = chunks.find((c) => c.symbol === 'load');
  assert.equal(load.startLine, 11);
  assert.equal(load.endLine, 13);
});

test('attaches doc comments and parent class', () => {
  const chunks = chunkFile({ relPath: 'sample.ts', text: SAMPLE, lang: 'ts' });
  assert.match(chunks.find((c) => c.symbol === 'add').doc, /Add two numbers/);
  assert.equal(chunks.find((c) => c.symbol === 'load').parent, 'Store');
});

test('classifies arrow functions as functions, scalars as consts', () => {
  const code = `export const LIMIT = 10;\nexport const double = (n) => n * 2;\n`;
  const chunks = chunkFile({ relPath: 'k.ts', text: code, lang: 'ts' });
  assert.deepEqual(chunks.map((c) => `${c.symbol}:${c.kind}`), ['double:function']);
});

test('survives braces and quotes inside strings and comments', () => {
  const code = `export function tricky() {
  const s = "}{ not a brace";
  // } neither is this
  /* { nor this */
  return s;
}
export function after() {
  return 1;
}
`;
  const chunks = chunkFile({ relPath: 't.ts', text: code, lang: 'ts' });
  assert.deepEqual(chunks.map((c) => c.symbol), ['tricky', 'after']);
});

test('parses python classes and methods by indentation', () => {
  const code = `class Repo:
    """A repository."""

    def load(self, path):
        return open(path)

def main():
    pass
`;
  const chunks = chunkFile({ relPath: 'r.py', text: code, lang: 'py' });
  assert.deepEqual(chunks.map((c) => c.symbol), ['Repo', 'load', 'main']);
  assert.equal(chunks.find((c) => c.symbol === 'load').parent, 'Repo');
  assert.match(chunks.find((c) => c.symbol === 'Repo').doc, /A repository/);
});

test('chunks code nested inside an IIFE wrapper', () => {
  const code = `(function () {
  function inner() {
    return 1;
  }
})();
`;
  const chunks = chunkFile({ relPath: 'w.js', text: code, lang: 'js' });
  assert.deepEqual(chunks.map((c) => c.symbol), ['inner']);
});
