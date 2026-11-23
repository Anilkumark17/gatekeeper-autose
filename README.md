# GateKeeper

GateKeeper indexes a JavaScript/TypeScript repository into a **dependency graph** stored in Postgres (Neon). From a vague bug report it will rank likely causes, verify them with probes in a git worktree, and suggest a fix—**without editing the user’s code**.

This repo is the **product** backend: TypeScript services, indexer pipeline, and API shell. Agent/diagnosis features are planned; the indexer foundation is in progress.

---

## Stack

| Layer | Choice |
|--------|--------|
| Runtime | Node 22, **strict** TypeScript, ESM (`NodeNext`) |
| HTTP | Express 5 |
| Database | Neon Postgres, **Drizzle ORM** + `pg` |
| Connections | Pooled `DATABASE_URL` (app), direct `DATABASE_URL_DIRECT` (migrations) |
| Parsing | **tree-sitter** (JS/JSX/TS/TSX grammars) |
| Validation | Zod (API + stage contracts only—not on hot indexer paths) |
| Tooling | pnpm, Vitest, Biome |

---

## What is completed

### Platform & ops

- Express app: logging (`pino`), static assets, **`/health`** and **`/health/db`**
- Config from `.env` (see `.env.example`)
- Drizzle schema + migrations (`0000`–`0002`), dual DB pools in `src/db/client.ts`
- `pnpm doctor` — environment and dependency checks
- CI-oriented scripts: `db:migrate`, `db:migrate:test` (test branch via `TEST_DATABASE_URL`)
- Cursor rules: [`.cursor/rules/gatekeeper.mdc`](.cursor/rules/gatekeeper.mdc)

### Indexer — discovery & metadata (steps 1–4)

- **Language detection** (`js` \| `jsx` \| `ts` \| `tsx`) from file extension
- **Skip rules**: `node_modules`, build dirs, declarations, minified/generated paths, size limits
- **File listing**: git-aware when available, filesystem walk fallback
- **Package / tsconfig map** per discovered file
- **Inspect head** for encoding and generated-file hints
- **`discover(root)`** — unified discovery result with counts and timing
- **`files.repo`** — persist discovery rows to Neon (integration test)

### Indexer — parse & symbols (steps 1–4, extractors prelude)

- **`parseSource`**: BOM strip, iterative **`walk`** (TreeCursor, no deep recursion on AST)
- Parse metrics: `hasError`, `errorCount`, timing
- **`extractSymbols`**: functions, classes, methods (incl. field arrows), const, React **components** / **hooks**
- Short hashes: `bodyHash`, `exportHash`; symbol IDs via `symbolId(path, qualifiedName)`
- Byte spans: **`startIndex`** / **`endIndex`** on each symbol (for enclosing scope / blame later)

### Indexer — module surface (imports / exports)

- **`extractImports`**: static, side-effect, `require`, dynamic `import()`
- **`extractExports`**: declarations, default, re-exports, CommonJS `module.exports`

### Indexer — per-file facts (T1: steps 5–8)

- **`extractUsages`**: one AST walk → **calls**, **refs**, **JSX renders**
- **`tokenize`**: searchable tokens from symbol/import/export names
- **`extractFile(path, source, lang)`** → **`FileFacts`** (no syntax tree returned; safe on parse errors)
- Fixtures under [`fixtures/sample-js/`](fixtures/sample-js/) for integration-style tests

### Analysis (early)

- **`detectSmells`** on AST (e.g. `debugger`, empty statement)
- Analyze route module exists; **not mounted** on the app yet

### Tests & benchmarks

- Broad Vitest coverage under `test/indexing/` and `test/core/`
- **`pnpm bench:parse`** — parse-only throughput on a repo (e.g. `fixtures/sample-js`, `bench/cal.com`)
- **`scripts/bench-extract.ts`** — full `extractFile` pass (manual; not wired in `package.json` yet)

**Sample numbers (local, Nov 2025):**

| Target | Metric |
|--------|--------|
| `fixtures/sample-js` | 11 files, parse bench ~0% error rate |
| `bench/cal.com` | ~5013 indexed files; parse ~531 files/s wall; extract ~109 files/s wall, ~0.46% parse errors |
| T1 perf test | 11 fixtures × 200 extracts &lt; 5 s |

---

## What is not done yet (roadmap)

| Area | Status |
|------|--------|
| **T2** Worker pool (piscina), timeouts, `extractAll` | Not started |
| **T3** Resolver (paths, barrels, call/ref binding, `flows_into`, hubs) | Not started |
| **T4** Git recency / blame on symbol ranges | Not started |
| **T5** COPY → stage → merge graph build | Not started |
| **T6+** Graph repos, search, watcher, diagnosis API, LLM agents, VS Code | Planned |
| Analysis API on Express | Implemented but **not wired** |
| `GraphStore` / ports | Interfaces only; repos not fully implemented |

---

## Engineering decisions

### Architecture boundaries

- **`src/core`**: only Zod, Pino, and Node built-ins—no Express, Drizzle, `pg`, or tree-sitter
- **SQL** lives only in `*.repo.ts`; pipeline code uses **ports** and plain row types
- **Node IDs** come from [`src/core/ids.ts`](src/core/ids.ts): POSIX repo-relative paths; symbols as `path#qualifiedName`
- **Syntax trees** never leave the function that parsed them; callers get **facts** (`FileFacts`, `SymbolFact`, etc.)

### Parsing & traversal

- Single shared **`walk()`** for AST visits; avoid unbounded recursion and whole-tree `node.children` loops
- Line numbers are **1-based** via `lines()`
- JS vs TS grammar differences handled explicitly (e.g. class field **`property`** vs **`name`** for `field_definition`)
- `import()` / `require()` recorded as imports, **excluded** from call facts

### Data & IDs

- **Dual Neon URLs**: pooler for requests, direct for Drizzle migrate/COPY (future)
- Separate **`TEST_DATABASE_URL`** for integration tests (must fail if missing on CI, not skip silently)
- **Content hash**: full SHA-256 hex of source on `FileFacts`
- Symbol **export hash** encodes kind + export shape signature (stable when body changes but shape does not)

### Extraction semantics (T1)

- **Enclosing scope**: innermost symbol by byte range `[startIndex, endIndex)`; else module `fileId(path)`
- **Refs**: known imported/top-level names only; exclude callees, bindings, member properties, keys; dedupe by `(fromId, name, role)`
- **JSX renders**: PascalCase or member components; intrinsics (`div`) ignored; spread props as `"..."`
- **Tokens**: split camel/snake/kebab/ALL_CAPS; drop short tokens and a small English stopword list

### Quality & process

- One ticket = one concern; allowed files per ticket; no new npm deps unless specified
- tree-sitter node types verified with `rootNode.toString()` on fixtures before matchers
- Existing test expectations are not weakened without an explicit reason

---

## Project layout

```
src/
  app.ts, index.ts          # HTTP bootstrap
  config/env.ts             # Zod env
  core/                     # ids, errors, types, schemas, ports, logger
  db/                       # Drizzle schema + client
  modules/
    health/                 # health routes
    analysis/               # smell + analyze schema (partial)
    indexing/               # discovery, parse, symbols, imports, exports, usages, extract-file
fixtures/sample-js/         # small JS fixture repo
drizzle/                    # SQL migrations
test/                       # Vitest
scripts/                    # doctor, migrate-test, bench-parse, bench-extract
bench/                      # large clones (e.g. cal.com) + results (local)
```

---

## Setup

```powershell
pnpm install
pnpm run setup          # copy .env.example → .env if missing
```

Edit `.env`: `DATABASE_URL`, `DATABASE_URL_DIRECT`, and `TEST_DATABASE_URL` (Neon test branch).

```powershell
pnpm run db:migrate           # main branch
pnpm run db:migrate:test      # test branch
```

---

## Commands

| Command | Purpose |
|---------|---------|
| `pnpm dev` | Dev server (`/health`, `/health/db`) |
| `pnpm test` | Full Vitest suite |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | Biome |
| `pnpm doctor` | Env / toolchain checks |
| `pnpm bench:parse <root>` | Parse benchmark |
| `pnpm exec tsx scripts/bench-extract.ts <root>` | Extract benchmark |

**T1 tests only:**

```powershell
pnpm vitest run test/indexing/tokens.test.ts test/indexing/usages.test.ts test/indexing/extract-file.test.ts
```

**Try one file manually** (POSIX path, correct `lang`):

```typescript
import { readFileSync } from "node:fs";
import { extractFile } from "./src/modules/indexing/extract-file.js";

const path = "fixtures/sample-js/receipt.js";
const facts = extractFile(path, readFileSync(path, "utf8"), "js");
console.log({ symbols: facts.symbols.length, calls: facts.calls.length, refs: facts.refs.length });
```

---

## Neon branches

Migrations apply to the database reached by **`DATABASE_URL_DIRECT`**. `db:migrate:test` targets **`TEST_DATABASE_URL`** only. Production/main and test branches are **separate**; each needs its own migrate run.

---

## License

ISC (see `package.json`).