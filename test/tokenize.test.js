import test from 'node:test';
import assert from 'node:assert/strict';
import { splitWords, tokensForIndex, tokensForQuery, estimateTokens } from '../src/tokenize.js';

test('splits camelCase, PascalCase and snake_case consistently', () => {
  assert.deepEqual(splitWords('getUserById'), ['get', 'user', 'by', 'id']);
  assert.deepEqual(splitWords('split_identifiers'), ['split', 'identifiers']);
  assert.deepEqual(splitWords('HTTPServerError'), ['http', 'server', 'error']);
  assert.deepEqual(splitWords('parseJSON'), ['parse', 'json']);
});

test('index and query sides share one vocabulary', () => {
  assert.deepEqual(tokensForIndex('getUserById'), tokensForQuery('get user by id'));
});

test('drops stopwords and duplicates', () => {
  const tokens = tokensForIndex('the value of the value is the thing');
  assert.equal(tokens.includes('the'), false);
  assert.equal(tokens.filter((t) => t === 'value').length, 1);
});

test('drops single characters but keeps short identifiers', () => {
  assert.deepEqual(splitWords('a bb ccc'), ['bb', 'ccc']);
});

test('estimates tokens more densely than prose', () => {
  assert.ok(estimateTokens('x'.repeat(360)) === 100);
  assert.equal(estimateTokens(''), 0);
});
