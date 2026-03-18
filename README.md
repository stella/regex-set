<p align="center">
  <img src=".github/assets/banner.png" alt="Stella" width="100%" />
</p>

# @stll/regex-set

[NAPI-RS](https://napi.rs/) bindings to Rust's
[regex-automata](https://github.com/rust-lang/regex/tree/main/regex-automata)
crate for Node.js and Bun.

Multi-pattern regex matching in a single pass.
Guaranteed O(m * n) — no catastrophic backtracking.
Built on the same regex engine that powers
[ripgrep](https://github.com/BurntSushi/ripgrep).

## Install

```bash
npm install @stll/regex-set
# or
bun add @stll/regex-set
```

Prebuilt binaries are available for:

| Platform      | Architecture |
| ------------- | ------------ |
| macOS         | x64, arm64   |
| Linux (glibc) | x64, arm64   |
| Linux (musl)  | x64          |
| Windows       | x64          |

## Usage

```typescript
import { RegexSet } from "@stll/regex-set";

const rs = new RegexSet([
  "\\d{2}\\.\\d{2}\\.\\d{4}",  // dates
  "\\+?\\d{9,12}",              // phones
  "[A-Z]{2}\\d{6}",             // IDs
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
rs.replaceAll(
  "Born 15.03.1990, phone +420123456789",
  ["[DATE]", "[PHONE]", "[ID]", "[EMAIL]"],
);
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
  "(?<!\\p{L})IČO:\\s*[0-9]{8}",  // lookbehind
  "[0-9]{6}/[0-9]{3,4}(?![0-9])", // lookahead
]);
```

Internally, lookaround is stripped from patterns,
the cores are compiled into a single fast DFA, and
assertions are verified as inline char checks on
each match (~1ns per check). No backtracking engine
involved for simple assertions.

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

### Large documents

| Scenario | @stll/regex-set | node-re2 | JS RegExp |
| --- | --- | --- | --- |
| mariomka 6.2 MB (3 patterns) | **20 ms** | 129 ms | 84 ms |
| Bible 4 MB (5 patterns) | **21 ms** | 114 ms | 58 ms |
| Bible 4 MB (10 patterns) | **14 ms** | 205 ms | 102 ms |
| Twain 16 MB (word boundary) | **15 ms** | 72 ms | 55 ms |
| Twain 16 MB (suffix match) | **26 ms** | 121 ms | 100 ms |

### Small documents (4 patterns)

| Size | @stll/regex-set | JS RegExp | Speedup |
| --- | --- | --- | --- |
| 0.6 KB | **4 μs** | 5 μs | 1.3x |
| 16 KB | **63 μs** | 115 μs | 1.8x |
| 27 KB | **107 μs** | 218 μs | 2.0x |
| 63 KB | **300 μs** | 550 μs | 1.8x |

### Anonymization workload (20 patterns)

| Size | @stll/regex-set | JS RegExp | Speedup |
| --- | --- | --- | --- |
| 0.6 KB | **3 μs** | 7 μs | 2.4x |
| 16 KB | **97 μs** | 189 μs | 1.9x |
| 27 KB | **149 μs** | 321 μs | 2.2x |
| 63 KB | **387 μs** | 934 μs | 2.4x |

### Unicode boundaries (zero overhead)

| Mode | 20 patterns, 27 KB | vs JS |
| --- | --- | --- |
| ASCII `\b` (default) | 149 μs | 2.2x faster |
| Unicode `\b` | 119 μs | 3.1x faster |
| JS RegExp (20 passes) | 363 μs | baseline |

### Backtracking resistance

| Pattern | Input | @stll/regex-set | JS RegExp |
| --- | --- | --- | --- |
| `(a+)+b` | `"a" × 30 + "X"` | **0.04 ms** | hangs |
| `.*.*=.*` | `"x" × 30 + "=" + "y" × 30` | **0.23 ms** | hangs |

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

| Method | Returns | Description |
| --- | --- | --- |
| `new RegexSet(patterns, options?)` | instance | Compile patterns |
| `.findIter(haystack)` | `Match[]` | All non-overlapping matches |
| `.isMatch(haystack)` | `boolean` | Any pattern matches? |
| `.whichMatch(haystack)` | `number[]` | Which pattern indices matched |
| `.replaceAll(haystack, replacements)` | `string` | Replace matches |
| `.patternCount` | `number` | Number of patterns |

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

# Run tests (47 unit + 17 property)
bun test
bun run test:props

# Download benchmark corpora
bun run bench:download

# Run benchmarks
bun run bench

# Lint & format
bun run lint
bun run format
```

## License

[MIT](./LICENSE)
