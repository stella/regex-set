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
