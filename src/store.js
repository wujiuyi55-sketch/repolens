import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Storage layer.
 *
 * SQLite + FTS5 is used as a *retrieval engine*, not as an application database:
 *   - `chunks` keeps the raw text (so a hit can be returned verbatim, never reconstructed);
 *   - `chunks_fts` is an external-content index over pre-tokenised columns, so the
 *     identifier splits computed at index time are exactly the terms queries match;
 *   - `files` exists so re-indexing can skip unchanged files (mtime + size).
 *
 * Pre-tokenising into separate columns (instead of indexing the body as-is) is what
 * makes `getUserById` findable by "user by id" *and* by "getUserById".
 */

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id      INTEGER PRIMARY KEY,
  path    TEXT NOT NULL UNIQUE,
  lang    TEXT NOT NULL,
  lines   INTEGER NOT NULL,
  bytes   INTEGER NOT NULL,
  mtime   REAL NOT NULL,
  skipped INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chunks (
  id         INTEGER PRIMARY KEY,
  file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  symbol     TEXT NOT NULL,
  parent     TEXT,
  kind       TEXT NOT NULL,
  lang       TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line   INTEGER NOT NULL,
  signature  TEXT NOT NULL DEFAULT '',
  doc        TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL,
  tokens     INTEGER NOT NULL DEFAULT 0,
  symbol_toks TEXT NOT NULL DEFAULT '',
  path_toks   TEXT NOT NULL DEFAULT '',
  doc_toks    TEXT NOT NULL DEFAULT '',
  body_toks   TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS chunks_file   ON chunks(file_id);
CREATE INDEX IF NOT EXISTS chunks_symbol ON chunks(symbol);
CREATE INDEX IF NOT EXISTS chunks_path   ON chunks(path);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  symbol_toks,
  path_toks,
  doc_toks,
  body_toks,
  content='chunks',
  content_rowid='id',
  tokenize='unicode61'
);
`;

/**
 * @param {string} file
 */
export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

/** Wipe the index but keep the schema (used by `repolens index --fresh`). */
export function clearIndex(db) {
  db.exec('DELETE FROM chunks_fts; DELETE FROM chunks; DELETE FROM files; DELETE FROM meta;');
}

/**
 * @param {DatabaseSync} db
 * @returns {(path: string) => { id: number, mtime: number, bytes: number } | undefined}
 */
export function fileLookup(db) {
  const stmt = db.prepare('SELECT id, mtime, bytes FROM files WHERE path = ?');
  return (path) => stmt.get(path);
}

/**
 * @param {DatabaseSync} db
 * @param {{ path: string, lang: string, lines: number, bytes: number, mtime: number }} file
 * @returns {number} file id
 */
export function upsertFile(db, file) {
  db.prepare(
    `INSERT INTO files (path, lang, lines, bytes, mtime)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET lang = excluded.lang, lines = excluded.lines,
       bytes = excluded.bytes, mtime = excluded.mtime`,
  ).run(file.path, file.lang, file.lines, file.bytes, file.mtime);
  const row = db.prepare('SELECT id FROM files WHERE path = ?').get(file.path);
  return Number(row.id);
}

/** Drop all chunks for a file before re-indexing it. */
export function deleteChunksForFile(db, fileId) {
  db.prepare('DELETE FROM chunks WHERE file_id = ?').run(fileId);
}

/**
 * @param {DatabaseSync} db
 * @param {number} fileId
 * @param {string} path
 * @param {import('./chunk.js').Chunk} chunk
 * @param {{ symbolToks: string, pathToks: string, docToks: string, bodyToks: string, tokens: number }} toks
 */
export function insertChunk(db, fileId, path, chunk, toks) {
  db.prepare(
    `INSERT INTO chunks
      (file_id, path, symbol, parent, kind, lang, start_line, end_line, signature, doc, body, tokens,
       symbol_toks, path_toks, doc_toks, body_toks)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fileId,
    path,
    chunk.symbol,
    chunk.parent ?? null,
    chunk.kind,
    chunk.lang,
    chunk.startLine,
    chunk.endLine,
    chunk.signature,
    chunk.doc,
    chunk.body,
    toks.tokens,
    toks.symbolToks,
    toks.pathToks,
    toks.docToks,
    toks.bodyToks,
  );
}

/** Rebuild the external-content FTS index after a bulk load. */
export function rebuildFts(db) {
  db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');");
  db.exec('ANALYZE;');
}

/**
 * @param {DatabaseSync} db
 * @param {string} key
 * @param {string} value
 */
export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}

/** @param {DatabaseSync} db */
export function getMeta(db) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM meta').all()) out[row.key] = row.value;
  return out;
}

/** @param {DatabaseSync} db */
export function indexStats(db) {
  const files = db.prepare('SELECT COUNT(*) AS n FROM files').get();
  const chunks = db.prepare('SELECT COUNT(*) AS n FROM chunks').get();
  const bytes = db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM files').get();
  const langs = db.prepare('SELECT lang, COUNT(*) AS n FROM files GROUP BY lang ORDER BY n DESC').all();
  const kinds = db.prepare('SELECT kind, COUNT(*) AS n FROM chunks GROUP BY kind ORDER BY n DESC').all();
  return {
    files: Number(files.n),
    chunks: Number(chunks.n),
    sourceBytes: Number(bytes.n),
    langs: langs.map((r) => ({ lang: r.lang, files: Number(r.n) })),
    kinds: kinds.map((r) => ({ kind: r.kind, chunks: Number(r.n) })),
  };
}
