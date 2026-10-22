import { estimateTokens } from './tokenize.js';

/**
 * Context packing.
 *
 * A retrieval result is only useful if it fits the caller's context window with room
 * to spare. So the packer is budget-driven: it emits results in relevance order and,
 * when the budget runs out, degrades gracefully — full body, then head of body, then
 * signature only, then a count of what was left out.
 */

const MIN_RESULT_TOKENS = 40;

/**
 * @param {Array<{ path: string, symbol: string, parent: string|null, kind: string, startLine: number, endLine: number, signature: string, body: string, score: number }>} results
 * @param {{ budgetTokens?: number, maxBodyLines?: number, header?: boolean }} [opts]
 * @returns {string}
 */
export function packResults(results, opts = {}) {
  const budget = opts.budgetTokens ?? 1200;
  const maxBodyLines = opts.maxBodyLines ?? 60;

  const out = [];
  let used = 0;
  let omitted = 0;

  for (const r of results) {
    const header = formatHeader(r);
    const body = clipBody(r.body, maxBodyLines);

    const full = `${header}\n${body}\n`;
    const fullTokens = estimateTokens(full);
    const remaining = budget - used;

    if (remaining < MIN_RESULT_TOKENS) {
      omitted++;
      continue;
    }

    if (fullTokens <= remaining) {
      out.push(full);
      used += fullTokens;
      continue;
    }

    // Degrade: keep the signature line and as much body as the budget allows.
    const signatureOnly = `${header}\n${r.signature}\n`;
    if (estimateTokens(signatureOnly) <= remaining) {
      const room = remaining - estimateTokens(signatureOnly);
      const chars = Math.max(0, Math.floor(room * 3.6));
      out.push(`${header}\n${r.signature}\n${r.body.slice(0, chars).trimEnd()}\n…\n`);
      used = budget;
    } else if (estimateTokens(header) <= remaining) {
      out.push(`${header}\n`);
      used += estimateTokens(header);
    } else {
      omitted++;
      continue;
    }
  }

  if (omitted > 0) out.push(`… ${omitted} lower-ranked result(s) omitted to fit the ${budget}-token budget.\n`);
  return out.join('\n').trimEnd();
}

function formatHeader(r) {
  const parent = r.parent ? `${r.parent}.` : '';
  return `### ${r.path}:${r.startLine}-${r.endLine}  ${parent}${r.symbol}()  [${r.kind}]`;
}

function clipBody(body, maxLines) {
  const lines = body.split('\n');
  if (lines.length <= maxLines) return body;
  return `${lines.slice(0, maxLines).join('\n')}\n// … ${lines.length - maxLines} more lines`;
}

/**
 * Token cost of a packed answer, used by the eval harness.
 * @param {string} text
 */
export function packedTokens(text) {
  return estimateTokens(text);
}
