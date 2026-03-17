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

// Check which patterns matched (not where)
rs.whichMatch("call +420123456789");
// [1]

// Replace all matches
rs.replaceAll(
  "Born 15.03.1990, phone +420123456789",
  ["[DATE]", "[PHONE]", "[ID]", "[EMAIL]"],
);
// "Born [DATE], phone [PHONE]"
```

## Why?

JS has no multi-regex engine. The standard approach
is a loop of `RegExp.exec()` calls — one full pass
per pattern. 10 patterns = 10 passes. This library
compiles all patterns into one automaton and scans
once.

- **O(m * n) guaranteed** — no backtracking
- **Single pass** — all patterns matched at once
- **Same `Match` type** as
  [@stll/aho-corasick](https://github.com/stella/aho-corasick):
  composable results, same UTF-16 offsets

## API

| Method | Returns | Description |
| --- | --- | --- |
| `new RegexSet(patterns)` | instance | Compile patterns |
| `.findIter(haystack)` | `Match[]` | All non-overlapping matches |
| `.isMatch(haystack)` | `boolean` | Any pattern matches? |
| `.whichMatch(haystack)` | `number[]` | Which pattern indices matched |
| `.replaceAll(haystack, replacements)` | `string` | Replace matches |
| `.patternCount` | `number` | Number of patterns |

### Types

```typescript
type Match = {
  pattern: number; // which regex matched
  start: number; // UTF-16 code unit offset
  end: number; // exclusive
  text: string; // matched substring
};
```

## Regex syntax

Uses Rust regex syntax. Similar to PCRE but:
- No backreferences
- No lookahead/lookbehind
- Unicode support by default (`\d` matches
  Unicode digits, `\w` matches Unicode word chars)

Full syntax:
[docs.rs/regex/latest/regex/#syntax](https://docs.rs/regex/latest/regex/#syntax)

## Limitations

- **No backreferences or lookaround.** By design:
  these features prevent O(n) guarantees.
- **Native dependency.** Requires a prebuilt binary
  or Rust toolchain.

## Acknowledgements

- [**regex**](https://github.com/rust-lang/regex)
  by Andrew Gallant (BurntSushi). MIT/Apache-2.0.
- [**NAPI-RS**](https://github.com/napi-rs/napi-rs).
  MIT.

## Development

```bash
bun install
bun run build    # requires Rust toolchain
bun test         # 18 tests
bun run lint
bun run format
```

## License

[MIT](./LICENSE)
