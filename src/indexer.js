import { join } from 'node:path';
import { chunkFile } from './chunk.js';
import { scanRepo, readSource } from './scan.js';
import {
  openDb,
  clearIndex,
  fileLookup,
  upsertFile,
  deleteChunksForFile,
  insertChunk,
  rebuildFts,
  setMeta,
  indexStats,
} from './store.js';
import { tokensForIndex, estimateTokens } from './tokenize.js';

/**
 * Build or refresh an index. Extracted from the CLI so the evaluation harness can
 * index a corpus in-process instead of shelling out and parsing its output.
 *
 * @param {{
 *   root: string,
 *   dbPath: string,
 *   fresh?: boolean,
 *   onProgress?: (event: { files: number, total: number }) => void,
 * }} opts
 */
export async function indexRepo({ root, dbPath, fresh = false, onProgress }) {
  const started = Date.now();
  const { files, skipped } = await scanRepo(root);

  const db = openDb(dbPath);
  if (fresh) clearIndex(db);
  const lookup = fileLookup(db);

  let changed = 0;
  let unchanged = 0;
  let chunkCount = 0;

  db.exec('BEGIN');
  try {
    for (const file of files) {
      const prev = lookup(file.relPath);
      if (prev && Math.abs(Number(prev.mtime) - file.mtime) < 1 && Number(prev.bytes) === file.bytes) {
        unchanged++;
        continue;
      }

      let text;
      try {
        text = await readSource(file.absPath);
      } catch {
        continue;
      }

      const chunks = chunkFile({ relPath: file.relPath, text, lang: file.lang });
      const fileId = upsertFile(db, {
        path: file.relPath,
        lang: file.lang,
        lines: text.split('\n').length,
        bytes: file.bytes,
        mtime: file.mtime,
      });
      deleteChunksForFile(db, fileId);

      for (const chunk of chunks) {
        insertChunk(db, fileId, file.relPath, chunk, {
          symbolToks: tokensForIndex(`${chunk.parent ?? ''} ${chunk.symbol}`).join(' '),
          pathToks: tokensForIndex(file.relPath).join(' '),
          docToks: tokensForIndex(chunk.doc).join(' '),
          bodyToks: tokensForIndex(chunk.body).join(' '),
          tokens: estimateTokens(chunk.body),
        });
        chunkCount++;
      }
      changed++;
      onProgress?.({ files: changed, total: files.length });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  rebuildFts(db);
  setMeta(db, 'root', root);
  setMeta(db, 'built_at', new Date().toISOString());
  setMeta(db, 'build_ms', String(Date.now() - started));

  const stats = indexStats(db);
  db.close();

  return { stats, scanned: files.length, changed, unchanged, skipped, chunks: chunkCount, ms: Date.now() - started };
}

/** Default index location for a repository. */
export function defaultDbPath(root) {
  return join(root, '.repolens', 'index.db');
}
