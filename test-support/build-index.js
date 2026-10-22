import { chunkFile } from '../src/chunk.js';
import { openDb, upsertFile, insertChunk, rebuildFts } from '../src/store.js';
import { tokensForIndex, estimateTokens } from '../src/tokenize.js';

/**
 * Build an in-memory index from a `{ path: source }` map.
 * Lives outside `test/` so the Node test runner does not execute it as a test file.
 * @param {Record<string, string>} files
 * @param {string} [dbPath]
 */
export function buildIndex(files, dbPath = ':memory:') {
  const db = openDb(dbPath);
  for (const [path, text] of Object.entries(files)) {
    const lang = path.endsWith('.py') ? 'py' : path.endsWith('.tsx') ? 'tsx' : 'ts';
    const chunks = chunkFile({ relPath: path, text, lang });
    const fileId = upsertFile(db, {
      path,
      lang,
      lines: text.split('\n').length,
      bytes: text.length,
      mtime: 1,
    });
    for (const chunk of chunks) {
      insertChunk(db, fileId, path, chunk, {
        symbolToks: tokensForIndex(`${chunk.parent ?? ''} ${chunk.symbol}`).join(' '),
        pathToks: tokensForIndex(path).join(' '),
        docToks: tokensForIndex(chunk.doc).join(' '),
        bodyToks: tokensForIndex(chunk.body).join(' '),
        tokens: estimateTokens(chunk.body),
      });
    }
  }
  rebuildFts(db);
  return db;
}
