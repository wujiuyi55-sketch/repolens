import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname, relative, sep } from 'node:path';

/** Directories that never contain source worth indexing. */
const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'dist', 'build', 'out',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', 'coverage', '.nyc_output',
  'vendor', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache',
  '.idea', '.vscode', '.repolens', 'target', 'bin', 'obj', 'Pods',
]);

/** Extensions we can chunk. Anything else is skipped rather than half-indexed. */
export const LANG_BY_EXT = {
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'js',
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.py': 'py',
};

const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 20_000;

/**
 * @typedef {object} ScannedFile
 * @property {string} relPath  POSIX-style path relative to the repo root.
 * @property {string} absPath
 * @property {string} lang
 * @property {number} bytes
 * @property {number} mtime
 */

/**
 * Walk a repository and return the source files worth indexing.
 * @param {string} root
 * @param {{ maxFiles?: number, maxBytes?: number }} [opts]
 * @returns {Promise<{ files: ScannedFile[], skipped: number }>}
 */
export async function scanRepo(root, opts = {}) {
  const maxFiles = opts.maxFiles ?? MAX_FILES;
  const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES;
  const files = [];
  let skipped = 0;

  /** @param {string} dir */
  async function walk(dir) {
    if (files.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.name.startsWith('.') && entry.name !== '.') {
        // Dotfiles are config, not source; .gitignore-adjacent noise.
        if (entry.isDirectory()) continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = extname(entry.name).toLowerCase();
      const lang = LANG_BY_EXT[ext];
      if (!lang) continue;
      if (/\.min\.(js|css)$/.test(entry.name)) continue;
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name) && entry.name.includes('.min.')) continue;

      const absPath = join(dir, entry.name);
      let info;
      try {
        info = await stat(absPath);
      } catch {
        skipped++;
        continue;
      }
      if (info.size > maxBytes) {
        skipped++;
        continue;
      }
      files.push({
        relPath: relative(root, absPath).split(sep).join('/'),
        absPath,
        lang,
        bytes: info.size,
        mtime: info.mtimeMs,
      });
    }
  }

  await walk(root);
  return { files, skipped };
}

/**
 * Read one file as UTF-8 text, normalising CRLF so offsets and line numbers agree.
 * @param {string} absPath
 * @returns {Promise<string>}
 */
export async function readSource(absPath) {
  const buf = await readFile(absPath);
  return buf.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
