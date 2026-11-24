# Engineering decisions

## 2026-11-24 Vitest runs test files serially

Parallel Vitest processes running tree-sitter native code crash intermittently on Windows
(exit 3221225477, 0xC0000005): 1 crash in 10 parallel runs, 0 in 10 serial runs.
Product code runs in one process with piscina threads and is unaffected.
Cost: slower suite. Revisit if the suite exceeds 60 s.

## 2026-11-24 Test-map coverage is incomplete evidence

No covering test = unknown coverage, not innocence (cal.com: **63%** of sampled exported symbols have no static test link at depth 5). **T12** must not penalise uncovered nodes.