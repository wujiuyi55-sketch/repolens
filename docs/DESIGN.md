# Design notes

Why repolens is built the way it is, what broke, and what I would do next.

## The problem, stated precisely

An agent editing code needs to answer questions like *"where is the retry backoff computed?"*
Today it runs `grep`, gets 30 hits, and reads whole files. Two costs:

- **Token cost** — a 600-line file is ~15k tokens; the answer is usually 30 lines.
- **Attention cost** — irrelevant code in the context window degrades later reasoning.

A code index has to optimise both at once. Improving recall while returning more text is
not an improvement. That tension drives every decision below.

## Module boundaries

```
scan.js      repo → [{ relPath, lang, bytes, mtime }]
chunk.js     file → [{ symbol, parent, kind, startLine, endLine, signature, doc, body }]
store.js     chunks → SQLite rows + FTS5 index
indexer.js   index a repo end to end (CLI and eval share it)
search.js    query → ranked chunks
pack.js      ranked chunks + budget → text for the model
tools.js     MCP tool definitions, thin over search/pack
mcp.js       JSON-RPC over stdio
```

`chunk.js` is the only module that knows about syntax. Everything downstream consumes the
`Chunk` record, so replacing the heuristic chunker with tree-sitter is a one-file change.

## Chunk model

A chunk is one declaration:

```
{
  symbol: "packResults",
  parent: null,              // "Store" for methods, "exports" for CJS assignments
  kind: "function",          // function | method | class | interface | type | const | export | test
  startLine: 22, endLine: 60,
  signature: "export function packResults(results, opts = {}) {",
  doc: "/** Context packing. … */",
  body: "<verbatim source, capped at 12 KB>"
}
```

Invariants the query layer relies on:

- `body` is **verbatim source**, never reconstructed. A retrieved answer must be pasteable.
- line ranges are exact: the UI shows `file:start-end`, and a wrong range undermines trust.
- `parent` is carried so a method can be found by its class name.

Scalar constants (`export const VERSION = '1.0'`), value re-exports
(`exports.json = bodyParser.json`) and `const x = require('y')` are dropped: they match
every query containing the word and answer none of them.

## What actually broke

Six bugs, all found by measuring coverage or recall on third-party code — none were
visible from unit tests I wrote against my own snippets.

**1. Destructuring parameters.** `function f({ a, b })` opens a brace inside the *parameter
list*. Matching the first `{` ended the chunk at the signature, so every statement in the
function body was subsequently scanned as a top-level declaration. The index filled with
chunks named `reader`, `config`, `i`. Fix: skip the balanced `( … )` before looking for the
body brace.

**2. Regex literals.** `/^[rub]*("""|''')/` contains quotes. The masker treated `'''` as a
string opener and blanked the rest of the file, so brace matching lost its balance and one
chunk swallowed 130 lines. Fix: detect regex starts by context (after an operator, opening
bracket, or keyword such as `return`) and skip to the closing `/`, respecting `\` escapes
and `[…]` character classes.

**3. Anonymous callbacks.** `test('…', () => { const tokens = … })` has no declaration for
the callback, so the scanner continued into its body and indexed local variables as if they
were module-level. Fix: a brace-depth map per line; deeper than depth 0 only *named*
declarations are trusted, never `const`/`let`.

**4. A size guard that silently skipped whole files.** `chunkFile` returned `[]` for any
file over ~96 KB. On zod that quietly excluded `core/schemas.ts`, `classic/schemas.ts` and
`v3/types.ts` — 11,000 lines, the heart of the library — with no error and no log line.
Only the coverage report found it (three files at 0%). Fix: remove the guard; `scan` already
bounds file size.

**5. Black-formatted signatures.** `def get(` with the closing `) -> Response:` at column 0
looked like a dedent to the indentation-based Python parser, so `httpx/_api.py`'s functions
were chunked as 12-line signatures. Fix: skip the signature by bracket depth, then start
indentation scanning at the colon that opens the body. Coverage on httpx: 83% → 87%.

**6. CommonJS.** Express attaches its entire API as `app.set = function set(…)`. A
`function`/`class`/`const`-only chunker indexed express's examples and missed
`lib/application.js`. Fix: recognise `exports.x =`, `module.exports = function`, and
`x.y = function` (parent = `x`). Coverage on express: 21% → 83%.

Lessons: the unit tests passed the whole time. Grammar heuristics fail on *other people's*
code, in ways that look like "no results" rather than "wrong results".

## Tokenisation

Index and query run through the same `splitWords`:

```
getUserById      → [get, user, by, id]
split_identifiers → [split, identifiers]
HTTPServer       → [http, server]
```

FTS5's `unicode61` tokeniser does no stemming, so the query side also tries truncations
(`directories` → `directory`, `caching` → `cach`). This is a poor man's Porter stemmer, and
it is where "directories" starts matching `isDirectory`.

Column layout and BM25 weights: `bm25(chunks_fts, 6.0, 2.0, 1.2, 1.0)` over
(symbol, path, doc, body).

## Retrieval and ranking

Two stages, deliberately separated:

1. **Recall.** The full-query FTS match returns up to 200 candidates. A *second* query
   restricts the same terms to the symbol column and merges its top 60. Without that
   second query, a chunk named exactly after the question can be pushed past the candidate
   cut-off by hundreds of chunks that merely mention its words in prose — on zod,
   `safeParse` never entered the candidate set at all.
2. **Precision.** Raw bm25 values span an order of magnitude, so any additive boost would
   be noise next to them. The lexical score is normalised into a 0–20 band and the signals
   decide:

| Signal | Weight |
| --- | --- |
| symbol equals the query | +50 |
| symbol contains the query | +18 |
| single-word symbol appears in the query (not a one-line alias) | +22 |
| symbol-column match (candidate came from the restricted query) | +5 |
| share of the question's concepts present in the body | up to +10 |
| share of the question's concepts present in the symbol | up to +18 |
| parent class named in the query | +8 |
| query term in the path | up to +9 |
| test/benchmark/docs path, query not about tests | −14 |
| `test`-kind chunk, query not about tests | −12 |

The "concepts present" term is what stops BM25 from preferring a long chunk that repeats
one rare word over a short chunk that answers the whole question. The last two rows are the
difference between `trim` in `classic/schemas.ts` and `trim` in `bench/compile-output.ts`.

## Packing

The packer walks results in score order and fills a token budget:

1. full header + body, if it fits;
2. otherwise header + signature + truncated body;
3. otherwise header only;
4. otherwise count it as omitted and say so.

The trailing "… N lower-ranked results omitted" line matters: a model that knows results
were cut can refine its query; a model that silently got a short answer cannot.

## Storage

External-content FTS5 over pre-tokenised columns:

```sql
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  symbol_toks, path_toks, doc_toks, body_toks,
  content='chunks', content_rowid='id', tokenize='unicode61'
);
```

Bodies are stored once in `chunks`; the FTS table is a derived view, rebuilt with
`INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')` after a bulk load. Incremental
reindexing compares `mtime` and `bytes` per file.

## Why zero dependencies

`node:sqlite` has shipped since Node 22.5, and MCP's stdio transport is newline-delimited
JSON-RPC 2.0 — roughly 150 lines. A tool that people run against arbitrary repositories
should not carry a native module or a version-sensitive SDK. The cost is that the transport
is maintained by hand; the benefit is that `git clone && node src/cli.js index .` works on a
fresh machine with nothing installed.

## Evaluating a retrieval tool honestly

The benchmark is 36 questions over three public repositories, 12 each, with hand-labelled
gold answers. Express and httpx questions were written from the projects' public API; zod's
from its v4 documentation and source layout.

Three things undermine the numbers, and they should be read as an upper bound:

- **I tuned the reranker while looking at these queries.** The weights above were chosen
  against these 36 questions. A held-out set would almost certainly score lower; the honest
  claim is "88.9% top-5 on 36 questions I wrote and tuned against", not "88.9% in general".
- **Gold answers are debatable.** "Where is `jsonp` implemented?" has several defensible
  answers (`res.jsonp`, the test that pins its behaviour, the body parser it delegates to).
  Four of the 36 are missed; reading them, two look like ranking failures and two look like
  gold-label failures.
- **Corpus skew.** zod's v4 code is largely generated one-line wrappers and type
  declarations, which is exactly the shape a lexical chunker handles worst. It scores 75%
  where express scores 100%. Reporting one aggregate number would hide that.

The self-index benchmark (`eval/queries.jsonl`, 12 questions about this repo) is used as a
CI regression gate at ≥ 90% top-5. It is a smoke alarm, not a result.

## What this design is not

- **Not semantic search.** No embeddings. For "how does auth work?", a vector index will
  beat BM25. The bet is that most agent questions name an identifier, a domain word, or a
  file — and that BM25 plus symbol boosts wins those cheaply and predictably.
- **Not an AST.** JSX and template-heavy code falls back to signature-only chunks.
- **Not a language server.** No type information, no cross-file resolution.

## Next

1. tree-sitter chunker behind the same interface, with the heuristic as fallback.
2. Import/call graph, so `find_references` answers structurally instead of lexically.
3. File watcher, so the index never goes stale mid-session.
4. A held-out query set, and weights re-fit on a corpus 100× larger.
