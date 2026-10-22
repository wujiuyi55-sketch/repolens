import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkFile } from '../src/chunk.js';

/* ------------------------------------------------------------------ */
/* CommonJS: the shape most npm packages actually ship                  */
/* ------------------------------------------------------------------ */

test('indexes exports.name = function', () => {
  const code = `exports.init = function init(app) {
  app.use(middleware);
};

exports.VERSION = '1.0.0';
`;
  const chunks = chunkFile({ relPath: 'lib/index.js', text: code, lang: 'js' });
  assert.deepEqual(
    chunks.map((c) => `${c.symbol}:${c.kind}`),
    ['init:function'],
  );
  assert.equal(chunks[0].parent, 'exports');
  assert.equal(chunks[0].endLine, 3);
});

test('indexes object property assignments', () => {
  const code = `var app = {};

app.set = function set(setting, val) {
  this.settings[setting] = val;
  return this;
};

app.get = (path, fn) => {
  return this.route(path)[fn];
};
`;
  const chunks = chunkFile({ relPath: 'lib/application.js', text: code, lang: 'js' });
  assert.deepEqual(
    chunks.map((c) => (c.parent ? `${c.symbol}@${c.parent}` : c.symbol)),
    ['app', 'set@app', 'get@app'],
  );
  const set = chunks.find((c) => c.symbol === 'set');
  assert.equal(set.startLine, 3);
  assert.equal(set.endLine, 6);
});

test('indexes module.exports = function name', () => {
  const code = `module.exports = function createApplication() {
  return {};
};
`;
  const chunks = chunkFile({ relPath: 'index.js', text: code, lang: 'js' });
  assert.deepEqual(
    chunks.map((c) => `${c.symbol}:${c.kind}`),
    ['createApplication:function'],
  );
});

test('skips re-export assignments', () => {
  const code = `module.exports = require('./lib/express');
exports.json = bodyParser.json;
`;
  const chunks = chunkFile({ relPath: 'index.js', text: code, lang: 'js' });
  assert.deepEqual(chunks.map((c) => c.symbol), []);
});

/* ------------------------------------------------------------------ */
/* Test blocks: `it` inside `describe` is the searchable unit          */
/* ------------------------------------------------------------------ */

test('indexes describe and it blocks by their description', () => {
  const code = `describe('res', function () {
  describe('.jsonp(object)', function () {
    it('should respond with jsonp', function (done) {
      res.jsonp({ count: 1 });
    });

    it('uses the first callback parameter', function () {
      res.jsonp({ count: 2 });
    });
  });
});
`;
  const chunks = chunkFile({ relPath: 'test/res.jsonp.js', text: code, lang: 'js' });
  const symbols = chunks.map((c) => c.symbol);
  assert.ok(symbols.includes('should respond with jsonp'));
  assert.ok(symbols.includes('uses the first callback parameter'));
  const leaf = chunks.find((c) => c.symbol === 'should respond with jsonp');
  assert.equal(leaf.kind, 'test');
  assert.equal(leaf.parent, '.jsonp(object)');
});

/* ------------------------------------------------------------------ */
/* Size, ASI and Python signatures                                     */
/* ------------------------------------------------------------------ */

test('does not skip large files', () => {
  const filler = 'const x = 1;\n'.repeat(6000);
  const code = `export function first() {\n  return 1;\n}\n${filler}\nexport function last() {\n  return 2;\n}\n`;
  const chunks = chunkFile({ relPath: 'big.ts', text: code, lang: 'ts' });
  assert.deepEqual(chunks.map((c) => c.symbol), ['first', 'last']);
  assert.ok(chunks[0].body.length < 200);
});

test('a statement without a semicolon ends at the next dedented line', () => {
  const code = `var app = express()
app.listen(3000)
function helper() {
  return 1;
}
`;
  const chunks = chunkFile({ relPath: 's.js', text: code, lang: 'js' });
  // `helper` must not be swallowed by the preceding expression statement.
  assert.ok(chunks.map((c) => c.symbol).includes('helper'));
  assert.equal(chunks.find((c) => c.symbol === 'helper').startLine, 3);
});

test('python signatures closed at column zero still find the body', () => {
  const code = `def get(
    url,
    *,
    timeout=None,
) -> Response:
    """Send a GET request."""
    return request("GET", url)


def after():
    pass
`;
  const chunks = chunkFile({ relPath: 'api.py', text: code, lang: 'py' });
  assert.deepEqual(chunks.map((c) => c.symbol), ['get', 'after']);
  assert.equal(chunks[0].endLine, 7);
  assert.match(chunks[0].doc, /Send a GET request/);
});
