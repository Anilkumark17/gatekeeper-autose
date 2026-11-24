# Board

- [open] T5-crash: `build-full.repo.test.ts` still crashes (0xC0000005) with serial files.
  Parallelism raises frequency but is not the only trigger. Workaround: run test
  files one at a time, e.g. `pnpm vitest run --no-file-parallelism test/indexing/build-full.repo.test.ts`
  instead of the full `pnpm test:db` suite in one invocation.