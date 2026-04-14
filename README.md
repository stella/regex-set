<p align="center">
  <img src=".github/assets/banner.png" alt="Stella" width="100%" />
</p>

# @stll/regex-set

[NAPI-RS](https://napi.rs/) bindings to Rust's
[regex-automata](https://github.com/rust-lang/regex/tree/main/regex-automata)
crate for Node.js and Bun.

Multi-pattern regex matching in a single pass.
Guaranteed O(m \* n) — no catastrophic backtracking.
Built on the same regex engine that powers
[ripgrep](https://github.com/BurntSushi/ripgrep).

## Install

The repository is public, but the npm package is
still in private beta. Public npm publishing is
planned for `v1.0.0`.

Until then, build from source:

```bash
bun install
bun run build
bun run build:js
```

If you already have beta access, you can install:

```bash
npm install @stll/regex-set
# or
bun add @stll/regex-set
```

For browsers, use the companion
`@stll/regex-set-wasm` package.

Private-beta builds currently ship prebuilts for:

| Platform      | Architecture |
| ------------- | ------------ |
| macOS         | x64, arm64   |
| Linux (glibc) | x64, arm64   |
| WASM          | browser      |

## Usage

```typescript
import { RegexSet } from "@stll/regex-set";

const rs = new RegexSet([
  "\\d{2}\\.\\d{2}\\.\\d{4}", // dates
  "\\+?\\d{9,12}", // phones
  "[A-Z]{2}\\d{6}", // IDs
  "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+", // emails
]);

rs.findIter("Born 15.03.1990, ID CZ123456");
// [
//   { pattern: 0, start: 5, end: 15,
//     text: "15.03.1990" },
//   { pattern: 2, start: 20, end: 28,
//     text: "CZ123456" },
// ]

// Quick check
rs.isMatch("call +420123456789"); // true

// Which patterns matched (not where)
rs.whichMatch("call +420123456789"); // [1]

// Replace all matches
rs.replaceAll("Born 15.03.1990, phone +420123456789", [
  "[DATE]",
  "[PHONE]",
  "[ID]",
  "[EMAIL]",
]);
// "Born [DATE], phone [PHONE]"
```

### Named patterns

```typescript
const rs = new RegexSet([
  { pattern: /\d{2}\.\d{2}\.\d{4}/, name: "date" },
  { pattern: /\+?\d{9,12}/, name: "phone" },
  "[A-Z]{2}\\d{6}", // unnamed
]);

rs.findIter("Born 15.03.1990, ID CZ123456");
// [
//   { pattern: 0, ..., name: "date" },
//   { pattern: 2, ..., text: "CZ123456" },
//   ← no `name` property on unnamed patterns
// ]
```

### Options

```typescript
const rs = new RegexSet(patterns, {
  // Only match whole words (default: false)
  wholeWords: true,

  // Unicode word boundaries (default: true)
  // Treats accented letters, CJK, etc. as word
  // characters. Auto UAX#29 for Thai/CJK.
  // Set to false for JS RegExp ASCII parity.
  unicodeBoundaries: true,
});
```

### Unicode word boundaries

By default, `\b` uses Unicode semantics — correct
for all scripts. Set `unicodeBoundaries: false` for
JS `RegExp` ASCII parity:

```typescript
// Default (Unicode \b): "čáp" is one word (CORRECT)
new RegexSet(["\\bp\\b"]).findIter("čáp");
// → [] (no match — p is inside a word)

// ASCII \b: "p" matches as standalone (WRONG)
new RegexSet(["\\bp\\b"], {
  unicodeBoundaries: false,
}).findIter("čáp");
// → [{ text: "p" }]

// Unicode \b: "čáp" is one word (CORRECT)
new RegexSet(["\\bp\\b"], {
  unicodeBoundaries: true,
}).findIter("čáp");
// → [] (no match — p is inside a word)

new RegexSet(["\\bčáp\\b"], {
  unicodeBoundaries: true,
}).findIter("malý čáp letí");
// → [{ text: "čáp" }]
```

Implementation: edge `\b` is stripped from patterns
and verified inline per match (two char lookups).
The DFA never sees `\b`, so there is zero overhead
regardless of mode. Unicode mode is actually
slightly faster because the DFA is simpler.

### Lookaround

Lookahead and lookbehind are supported:

```typescript
const rs = new RegexSet([
  "(?<!\\p{L})IČO:\\s*[0-9]{8}", // lookbehind
  "[0-9]{6}/[0-9]{3,4}(?![0-9])", // lookahead
]);
```

Internally, lookaround is stripped from patterns,
the cores are compiled into a single fast DFA, and
assertions are verified as inline char checks on
each match (~1ns per check). No backtracking engine
involved for simple assertions.

When a greedy quantifier (e.g., `\s*`) causes the DFA
to overshoot past a valid match boundary and the
lookahead rejects the longer match, the engine falls
back to `fancy-regex` for that specific match to
backtrack the quantifier and find the shorter valid
match. This fallback is ~5-6x slower per affected
match but ensures correctness; patterns without
lookaround are unaffected.

## Benchmarks

Measured on Apple M3, 24 GB RAM, macOS 25.3.0.
Automaton pre-built; times are search-only averaged
over multiple runs.

Corpora:
[mariomka/regex-benchmark](https://github.com/mariomka/regex-benchmark),
[rust-leipzig/regex-performance](https://github.com/rust-leipzig/regex-performance),
[Canterbury Large Corpus](https://corpus.canterbury.ac.nz/).

Run locally:
`bun run bench:download && bun run bench`

### Large documents (academic corpora)

| Scenario                     | @stll/regex-set | JS RegExp | Speedup |
| ---------------------------- | --------------- | --------- | ------- |
| mariomka 6.2 MB (3 patterns) | **20 ms**       | 112 ms    | 5.5x    |
| Bible 4 MB (5 multi-pattern) | **17 ms**       | 122 ms    | 7.0x    |
| Bible 4 MB (3 + lookaround)  | **47 ms**       | 82 ms     | 1.8x    |
| Twain 16 MB (word boundary)  | **17 ms**       | 72 ms     | 4.1x    |
| Twain 16 MB (alternation)    | **12 ms**       | 44 ms     | 3.7x    |
| Twain 16 MB (suffix match)   | **24 ms**       | 142 ms    | 5.8x    |

### Production PII patterns (13 patterns + lookaround)

| Size   | @stll/regex-set | JS RegExp | Speedup |
| ------ | --------------- | --------- | ------- |
| 8 KB   | **0.09 ms**     | 0.12 ms   | 1.3x    |
| 16 KB  | **0.15 ms**     | 0.23 ms   | 1.5x    |
| 32 KB  | **0.28 ms**     | 0.44 ms   | 1.6x    |
| 64 KB  | **0.63 ms**     | 0.98 ms   | 1.6x    |
| 128 KB | **1.17 ms**     | 1.79 ms   | 1.5x    |
| 256 KB | **2.30 ms**     | 3.47 ms   | 1.5x    |

### Real Czech contracts (20 anonymization patterns)

| Size   | @stll/regex-set | JS RegExp | Speedup |
| ------ | --------------- | --------- | ------- |
| 0.6 KB | **5 μs**        | 9 μs      | 1.8x    |
| 16 KB  | **80 μs**       | 265 μs    | 3.3x    |
| 27 KB  | **152 μs**      | 448 μs    | 2.9x    |
| 63 KB  | **467 μs**      | 1016 μs   | 2.2x    |

### Backtracking resistance

| Pattern   | Input                       | @stll/regex-set | JS RegExp |
| --------- | --------------------------- | --------------- | --------- |
| `(a+)+b`  | `"a" × 30 + "X"`            | **0.12 ms**     | hangs     |
| `.*.*=.*` | `"x" × 30 + "=" + "y" × 30` | **0.25 ms**     | hangs     |

All match counts verified against JS RegExp.
For pure literal patterns, use
[@stll/aho-corasick](https://github.com/stella/aho-corasick)
instead (V8 has a SIMD fast path for literals that
no regex engine can match).

<details>
<summary>Alternatives tested</summary>

- [node-re2](https://www.npmjs.com/package/re2)
  — Google RE2 via C++, single pattern per call
- JS RegExp — V8 built-in, per-pattern loop

</details>

## API

| Method                                | Returns    | Description                   |
| ------------------------------------- | ---------- | ----------------------------- |
| `new RegexSet(patterns, options?)`    | instance   | Compile patterns              |
| `.findIter(haystack)`                 | `Match[]`  | All non-overlapping matches   |
| `.isMatch(haystack)`                  | `boolean`  | Any pattern matches?          |
| `.whichMatch(haystack)`               | `number[]` | Which pattern indices matched |
| `.replaceAll(haystack, replacements)` | `string`   | Replace matches               |
| `.patternCount`                       | `number`   | Number of patterns            |

### Types

```typescript
type PatternEntry =
  | string
  | RegExp
  | { pattern: string | RegExp; name?: string };

type Options = {
  wholeWords?: boolean;
  unicodeBoundaries?: boolean;
};

type Match = {
  pattern: number; // which regex matched
  start: number; // UTF-16 code unit offset
  end: number; // exclusive
  text: string; // matched substring
  name?: string; // pattern name (if provided)
};
```

Same `Match` type as
[@stll/aho-corasick](https://github.com/stella/aho-corasick):
composable results, same UTF-16 offsets compatible
with `String.prototype.slice()`.

## Regex syntax

Uses Rust regex syntax. Similar to PCRE but:

- No backreferences (by design: enables O(n))
- Lookahead/lookbehind supported (via inline
  char checks, no backtracking)
- Unicode support by default (`\d` matches
  Unicode digits, `\w` matches Unicode word chars)

Full syntax:
[docs.rs/regex](https://docs.rs/regex/latest/regex/#syntax)

## Limitations

- **No backreferences.** By design: enables the
  O(n) guarantee. Use JS RegExp for patterns that
  need backreferences.
- **Single literal patterns are slower than JS.**
  V8 uses SIMD memchr for single literals. Use
  [@stll/aho-corasick](https://github.com/stella/aho-corasick)
  for literal string matching.

### Using with Vite

Vite's dependency pre-bundler rewrites
`import.meta.url`, which breaks the relative
`.wasm` path emitted by the napi-rs loader. Import
the bundled plugin so the package is excluded from
pre-bundling:

```ts
// vite.config.ts
import stllWasm from "@stll/regex-set-wasm/vite";

export default {
  plugins: [stllWasm()],
};
```

## Acknowledgements

- [**regex**](https://github.com/rust-lang/regex)
  by Andrew Gallant (BurntSushi). MIT/Apache-2.0.
- [**fancy-regex**](https://github.com/fancy-regex/fancy-regex)
  for lookaround support. MIT.
- [**NAPI-RS**](https://github.com/napi-rs/napi-rs).
  MIT.

## Development

```bash
# Install dependencies
bun install

# Build native module (requires Rust toolchain)
bun run build
bun run build:js

# Run tests
bun test
bun run test:props

# Download benchmark corpora
bun run bench:download

# Run benchmark suites
bun run bench:all

# Lint & format
bun run lint
bun run format

# Rust quality gates
cargo clippy --all-targets -- -Dwarnings
cargo fmt -- --check
```

## License

[MIT](./LICENSE)
