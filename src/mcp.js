import { TOOLS, callTool } from './tools.js';

/**
 * Minimal MCP server over stdio.
 *
 * The Model Context Protocol's stdio transport is newline-delimited JSON-RPC 2.0:
 * one message per line, UTF-8, no Content-Length framing (that is LSP). Implementing
 * it directly keeps this package dependency-free — an important property for a tool
 * that people will `npx` into arbitrary environments.
 *
 * Supported methods: initialize, ping, tools/list, tools/call. Everything else is a
 * clean -32601 so a client can fall back instead of hanging.
 */

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'repolens', version: '0.1.0' };

/**
 * @param {{ db: import('node:sqlite').DatabaseSync, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} opts
 * @returns {Promise<void>} resolves when the client closes stdin
 */
export function startMcpServer({ db, input = process.stdin, output = process.stdout }) {
  /** @param {any} msg */
  const send = (msg) => output.write(`${JSON.stringify(msg)}\n`);

  /** @param {any} id @param {any} result */
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  /** @param {any} id @param {number} code @param {string} message */
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  /** @param {any} msg */
  function handle(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return;
    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
    const id = hasId ? msg.id : null;

    switch (msg.method) {
      case 'initialize': {
        const requested = msg.params?.protocolVersion;
        const version = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
        reply(id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            'repolens indexes a repository into declaration-level chunks. Call search_code first; ' +
            'use get_symbol for full source and find_references before renaming.',
        });
        return;
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return; // notifications never get a response

      case 'ping':
        reply(id, {});
        return;

      case 'tools/list':
        reply(id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
        return;

      case 'tools/call': {
        const name = msg.params?.name;
        const args = msg.params?.arguments ?? {};
        const result = callTool(String(name), args, { db });
        reply(id, result);
        return;
      }

      default:
        if (!hasId) return;
        fail(id, -32601, `Method not found: ${msg.method}`);
    }
  }

  return new Promise((resolve) => {
    let buffer = '';
    input.setEncoding?.('utf8');

    input.on('data', (/** @type {string} */ chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
          continue;
        }
        try {
          handle(msg);
        } catch (err) {
          if (msg && Object.prototype.hasOwnProperty.call(msg, 'id')) {
            fail(msg.id, -32603, `Internal error: ${/** @type {Error} */ (err).message}`);
          }
        }
      }
    });

    input.on('end', resolve);
    input.on('close', resolve);
  });
}
