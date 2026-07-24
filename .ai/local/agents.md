## Repository Specifics

`@stll/regex-set` is a Node/Bun package backed by a Rust multi-pattern regex engine, with native and WASM package outputs.

### Commands

- `bun install`
- `bun run lint`
- `bun run typecheck`
- `bun test`
- `bun run test:props`
- `bun run test:runtime:bun`
- `bun run test:runtime:node`
- `bun run build:js`
- `bun run version:check`

### Native Package Rules

- Preserve backtracking-immune behavior and Unicode word-boundary semantics.
- Keep native, WASM, Bun, and Node runtime behavior aligned.
- Add focused tests for match spans, captures, fallback behavior, and pattern-set ordering whenever those semantics change.

### CI Package Manager

- Use the Bun version declared by `packageManager` in `package.json`.
- Install repository and fixture dependencies with `bun install --frozen-lockfile`.
- Do not use npm, yarn, or pnpm for repository dependency installation. Global npm tool installation is allowed.

### Releases

- Every pull request that changes published runtime code must add a Changesets entry; use `bun run changeset --empty` for an intentional no-release change.
- Changesets owns `CHANGELOG.md` and the version PR. The version command synchronizes `VERSION`, every npm package, Cargo manifests and lock metadata, and the generated native loader guard.
- Keep `.github/workflows/release.yml` as the trusted-publishing caller. Do not add another changelog generator or publish from the Changesets workflow.
