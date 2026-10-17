<p align="center">
  <img src=".github/assets/banner.png" alt="stella" width="100%" />
</p>

# @stll/regex-set

[NAPI-RS](https://napi.rs/) bindings to Rust's
[regex-automata](https://github.com/rust-lang/regex/tree/main/regex-automata)
crate for Node.js and Bun.

Multi-pattern regex matching in a single pass.
Backtracking-free on the main DFA path, with a
targeted fallback for some lookaround cases.
Built on the same regex engine that powers
[ripgrep](https://github.com/BurntSushi/ripgrep).

## Install

```bash
npm install @stll/regex-set
# or
bun add @stll/regex-set
```

The companion `@stll/regex-set-wasm` package is
available for browser builds.

You do not need Vite to use `@stll/regex-set` in
Node.js or Bun. Vite is only relevant for the
browser/WASM companion package.

Prebuilts are available for:

| Platform      | Architecture |
| ------------- | ------------ |
| macOS         | x64, arm64   |
| Linux (glibc) | x64, arm64   |
| WASM          | browser      |

### Single-thread browser and WebView entry

`@stll/regex-set-wasm/single-thread` loads a separate
`wasm32-unknown-unknown` build of the shared Rust core. It requires neither
`SharedArrayBuffer`, a worker, nor COOP/COEP headers. Import has no fetch or
WebAssembly allocation; initialization is explicit. Matcher construction and
all search methods are synchronous after initialization. Patterns, haystacks,
and replacement strings use Unicode scalars; offsets index the normalized
well-formed string in UTF-16 code units.

The default entry requires caller-supplied bytes or a URL. It never chooses
an asset URL automatically:

```ts
import {
  init,
  RegexSet,
} from "@stll/regex-set-wasm/single-thread";

// Copy the exported single-thread/wasm asset into your extension's assets.
await init(
  chrome.runtime.getURL(
    "assets/regex-set.single-thread.wasm",
  ),
);
const matcher = new RegexSet(["foo", "bar"]);
matcher.findIter("foo bar");
```

`init(url)` fetches bytes and calls `WebAssembly.instantiate`; it does not
require a WASM MIME type. `init(request)` accepts a caller-supplied `Request`;
`init(response)` consumes an existing successful `Response` without fetching.
These inputs and byte buffers can come from another realm. Byte inputs include
`ArrayBuffer` and its views (including `Buffer` and `DataView`); only the view's
byte range is used. `init(bytes)` performs no I/O. For bytes already
available to an injected script, `initSync(bytes)` performs no I/O and returns
immediately. The asset is exported as
`@stll/regex-set-wasm/single-thread/wasm` for bundlers or copying.

For a self-contained bundle, opt into the inline entry:

```ts
import {
  initSync,
  RegexSet,
} from "@stll/regex-set-wasm/single-thread/inline";

initSync(); // Decode embedded base64 and instantiate synchronously; no fetch.
new RegexSet(["clipboard", "highlight"]).isMatch(
  "clipboard",
);
```

Inline import also defers decoding and memory allocation until `initSync()`.
Base64 adds `4 * ceil(wasmBytes / 3) - wasmBytes` bytes before compression,
approximately 33%. Every build measures raw, base64, and gzip sizes, prints
them in the build log, and includes the exact values in
`wasm/dist/single-thread-size.json`. URL loading avoids adding those base64
bytes to the JavaScript bundle. The package includes both options.

Neither entry uses `eval`, `new Function`, blob URLs, or worker startup. CSP
still governs WebAssembly compilation: Chromium-based extension pages and
WebViews generally need `script-src 'self' 'wasm-unsafe-eval'`. A literal
`script-src 'self'` policy that forbids WASM compilation cannot run this or any
other compiling WASM loader. Tauri can bundle the raw asset and pass bytes or
its permitted asset URL without cross-origin isolation; configure its WebView
CSP to allow WebAssembly. Caller URL loading must also be allowed by
`connect-src` and the platform's asset permissions. Inline initialization
needs no network permission.

The original package entry retains its threaded loader. Both entries share
the public API, including prepared patterns, named patterns, buffer search,
and replacement; initializing one entry does not rebind the other's classes.

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
The DFA never sees `\b`, so boundary verification
stays O(1) per match in either mode.

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
each match. No backtracking engine is involved for
simple assertions.

When a greedy quantifier (e.g., `\s*`) causes the DFA
to overshoot past a valid match boundary and the
lookahead rejects the longer match, the engine falls
back to `fancy-regex` for that specific match to
backtrack the quantifier and find the shorter valid
match. This fallback is slower on affected matches
but preserves correctness; patterns without
lookaround are unaffected.

## Benchmarks

The repository includes only public, reproducible
benchmark inputs and scripts in `__bench__/`.

Inputs:

- [mariomka/regex-benchmark](https://github.com/mariomka/regex-benchmark)
- [rust-leipzig/regex-performance](https://github.com/rust-leipzig/regex-performance)
- [Canterbury Large Corpus](https://corpus.canterbury.ac.nz/)

Run them locally:

```bash
bun install
bun run build
bun run bench:download
bun run bench
bun run bench:fallback
```

Representative baseline from the checked-in public
harness:

- runtime: Bun `1.3.10`
- platform: macOS `26.4.1` (`Darwin arm64`)

| Scenario                                                         | `@stll/regex-set` | JS `RegExp` |      Relative |
| ---------------------------------------------------------------- | ----------------: | ----------: | ------------: |
| mariomka, 3 patterns, 6.2 MB                                     |          19.08 ms |   102.67 ms | `5.4x` faster |
| Twain literal `Twain`, 16.0 MB                                   |           9.47 ms |     1.21 ms |       `0.13x` |
| Twain char class `[a-z]shing`, 16.0 MB                           |          10.38 ms |     8.01 ms |       `0.77x` |
| Twain word boundary `\\b\\w+nn\\b`, 16.0 MB                      |          13.00 ms |    55.59 ms | `4.3x` faster |
| Twain alternation <code>Tom&#124;Sawyer&#124;...</code>, 16.0 MB |           9.20 ms |    20.77 ms | `2.3x` faster |
| Twain suffix `[a-zA-Z]+ing`, 16.0 MB                             |          15.79 ms |    91.93 ms | `5.8x` faster |
| Bible, 5 patterns, 4.0 MB                                        |          12.20 ms |    57.52 ms | `4.7x` faster |
| Bible, 3 lookaround patterns, 4.0 MB                             |          25.93 ms |    77.33 ms | `3.0x` faster |

Fallback-path microbenchmark in the same
environment:

| Scenario                          |     Time |
| --------------------------------- | -------: |
| baseline DFA, no lookaround       | 0.168 ms |
| verifier present, no fallback     | 0.134 ms |
| verifier + `fancy-regex` fallback | 0.829 ms |

The benchmark harness covers:

- multi-pattern scanning on public corpora
- lookaround-heavy scans
- catastrophic backtracking resistance
- the verifier + `fancy-regex` fallback path

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

- **Non-Unicode case-insensitive RegExp inputs retain the existing translation.**
  Their whitespace classes and Unicode literal case folding can differ from
  JavaScript. Prefer Unicode RegExp inputs for Unicode text.

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
bun run bench
bun run bench:fallback

# Lint & format
bun run lint
bun run format

# Rust quality gates
cargo clippy --all-targets --all-features -- -D warnings
cargo fmt --all -- --check
```

Run `bun run typecheck` to check types with `bun check --no-pretty --all --project=tsconfig.json`.
Run `bun run check:typecheck-parity` to compare repository diagnostics and seeded diagnostic classes with TypeScript; CI runs both checks.
Editors continue to use the TypeScript language service because Bun has no language server.
The `typescript` dependency also supports declaration generation through tsdown.

## License

[Apache-2.0](./LICENSE)
