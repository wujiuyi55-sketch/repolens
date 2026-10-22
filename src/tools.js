import { search, snippet } from './search.js';
import { packResults } from './pack.js';
import { indexStats } from './store.js';
import { tokensForQuery } from './tokenize.js';

/**
 * MCP tool surface.
 *
 * Four tools, each answering a question an agent actually asks while editing code:
 *   - search_code       "where does X live?"
 *   - get_symbol        "show me X in full"
 *   - find_references   "who else touches X?"
 *   - index_stats       "is this repo even indexed?"
 *
 * Every result is text, never a file handle: the agent should not need a second
 * round-trip just to read what it already found.
 */

/** @typedef {{ db: import('node:sqlite').DatabaseSync }} ToolContext */

export const TOOLS = [
  {
    name: 'search_code',
    description:
      'Search the indexed repository for code matching a natural-language or identifier query. ' +
      'Returns the most relevant declarations with file paths, line ranges, and bodies packed into a token budget.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, e.g. "where is bm25 ranking applied".' },
        limit: { type: 'number', description: 'Max results (default 8).' },
        budgetTokens: { type: 'number', description: 'Max tokens in the response (default 1200).' },
        path: { type: 'string', description: 'Optional path prefix filter, e.g. "src/search".' },
      },
      required: ['query'],
    },
    handler: searchCode,
  },
  {
    name: 'get_symbol',
    description: 'Return the full source of a named function, class, or method. Exact match first, then case-insensitive.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name, e.g. "packResults".' },
        path: { type: 'string', description: 'Optional path prefix to disambiguate duplicates.' },
      },
      required: ['name'],
    },
    handler: getSymbol,
  },
  {
    name: 'find_references',
    description: 'Find every chunk whose body mentions an identifier. Useful before renaming or changing a signature.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Identifier to look for.' },
        limit: { type: 'number', description: 'Max references (default 20).' },
      },
      required: ['name'],
    },
    handler: findReferences,
  },
  {
    name: 'index_stats',
    description: 'Report what the index covers: file count, chunk count, languages, and index build time.',
    inputSchema: { type: 'object', properties: {} },
    handler: stats,
  },
];

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {ToolContext} ctx
 * @returns {{ content: Array<{ type: 'text', text: string }>, isError?: boolean }}
 */
export function callTool(name, args, ctx) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
  try {
    return tool.handler(args ?? {}, ctx);
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Tool ${name} failed: ${/** @type {Error} */ (err).message}` }],
      isError: true,
    };
  }
}

/* ------------------------------------------------------------------ */

function searchCode(args, { db }) {
  const query = String(args.query ?? '').trim();
  if (!query) return text('Provide a `query`.');

  const results = search(db, query, {
    limit: clamp(Number(args.limit ?? 8), 1, 20),
    pathPrefix: args.path ? String(args.path) : undefined,
  });

  if (results.length === 0) {
    return text(`No indexed chunk matched "${query}". Try fewer or different terms, or run \`repolens index\`.`);
  }

  const packed = packResults(results, { budgetTokens: clamp(Number(args.budgetTokens ?? 1200), 200, 8000) });
  return text(packed);
}

function getSymbol(args, { db }) {
  const name = String(args.name ?? '').trim();
  if (!name) return text('Provide a `name`.');

  const prefix = args.path ? `${String(args.path)}%` : '%';
  const rows = db
    .prepare(
      `SELECT path, symbol, parent, kind, start_line, end_line, signature, body
         FROM chunks
        WHERE symbol = ? COLLATE NOCASE AND path LIKE ?
        ORDER BY LENGTH(body) ASC
        LIMIT 3`,
    )
    .all(name, prefix);

  if (rows.length === 0) {
    return text(`No symbol named "${name}" in the index. Use search_code to find the right name.`);
  }

  return text(
    rows
      .map((r) => {
        const parent = r.parent ? `${r.parent}.` : '';
        return `### ${r.path}:${r.start_line}-${r.end_line}  ${parent}${r.symbol}()  [${r.kind}]\n\`\`\`\n${r.body}\n\`\`\``;
      })
      .join('\n\n'),
  );
}

function findReferences(args, { db }) {
  const name = String(args.name ?? '').trim();
  if (!name) return text('Provide a `name`.');
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return text('`name` must be a single identifier.');

  const limit = clamp(Number(args.limit ?? 20), 1, 100);
  const rows = db
    .prepare(
      `SELECT path, symbol, parent, start_line, end_line, body
         FROM chunks
        WHERE body LIKE ?
        ORDER BY path
        LIMIT ?`,
    )
    .all(`%${name}%`, limit);

  if (rows.length === 0) return text(`No chunk mentions "${name}".`);

  const tokens = tokensForQuery(name);
  const lines = rows.map((r) => {
    const parent = r.parent ? `${r.parent}.` : '';
    return `- ${r.path}:${r.start_line}-${r.end_line}  ${parent}${r.symbol}()  — ${snippet(r.body, tokens, 100)}`;
  });

  return text(`Found ${rows.length} chunk(s) mentioning "${name}":\n\n${lines.join('\n')}`);
}

function stats(_args, { db }) {
  const s = indexStats(db);
  const langs = s.langs.map((l) => `${l.lang}: ${l.files}`).join(', ');
  return text(
    [
      `files: ${s.files}`,
      `chunks: ${s.chunks}`,
      `source bytes: ${s.sourceBytes}`,
      `languages: ${langs || 'none'}`,
      `chunk kinds: ${s.kinds.map((k) => `${k.kind}=${k.chunks}`).join(', ') || 'none'}`,
    ].join('\n'),
  );
}

function text(text) {
  return { content: [{ type: 'text', text }] };
}

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
