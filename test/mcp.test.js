import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { buildIndex } from '../test-support/build-index.js';
import { startMcpServer } from '../src/mcp.js';

const FILES = {
  'src/pack.js': `export function packResults(results, budget) {
  return results.slice(0, budget);
}
`,
  'src/store.js': `export function openDb(file) {
  return file;
}
`,
};

function harness(db) {
  const input = new PassThrough();
  const written = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      written.push(chunk.toString());
      cb();
    },
  });

  const done = startMcpServer({ db, input, output });
  return {
    send: (msg) => input.write(`${JSON.stringify(msg)}\n`),
    finish: async () => {
      input.end();
      await done;
      return written
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
}

test('completes the initialize handshake', async () => {
  const db = buildIndex(FILES);
  const h = harness(db);
  h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const [reply] = await h.finish();

  assert.equal(reply.id, 1);
  assert.equal(reply.result.protocolVersion, '2025-06-18');
  assert.equal(reply.result.serverInfo.name, 'repolens');
  assert.ok(reply.result.capabilities.tools);
});

test('advertises tools with JSON schemas', async () => {
  const db = buildIndex(FILES);
  const h = harness(db);
  h.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const [reply] = await h.finish();

  const names = reply.result.tools.map((t) => t.name);
  assert.deepEqual(names, ['search_code', 'get_symbol', 'find_references', 'index_stats']);
  for (const tool of reply.result.tools) assert.equal(tool.inputSchema.type, 'object');
});

test('runs a search through tools/call', async () => {
  const db = buildIndex(FILES);
  const h = harness(db);
  h.send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'search_code', arguments: { query: 'pack results' } },
  });
  const [reply] = await h.finish();

  assert.ok(reply.result.content[0].text.includes('packResults'));
  assert.equal(reply.result.isError, undefined);
});

test('reports unknown tools as an error result, not a transport failure', async () => {
  const db = buildIndex(FILES);
  const h = harness(db);
  h.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  const [reply] = await h.finish();

  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /Unknown tool/);
});

test('returns -32601 for unknown methods and stays alive', async () => {
  const db = buildIndex(FILES);
  const h = harness(db);
  h.send({ jsonrpc: '2.0', id: 5, method: 'resources/list' });
  h.send({ jsonrpc: '2.0', id: 6, method: 'ping' });
  const replies = await h.finish();

  assert.equal(replies[0].error.code, -32601);
  assert.deepEqual(replies[1].result, {});
});

test('reports parse errors without dropping the connection', async () => {
  const db = buildIndex(FILES);
  const h = harness(db);
  h.send({ jsonrpc: '2.0', id: 7, method: 'ping' });
  const replies = await h.finish();
  assert.equal(replies[0].id, 7);
});
