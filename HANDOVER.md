# @stll/regex-set — Handover Document

## What this library does

Multi-pattern regex matching for Node.js/Bun via
NAPI-RS bindings to Rust's `regex-automata` crate.
Compiles N regex patterns into a single DFA,
scans text once, returns all non-overlapping matches.
Guaranteed O(m×n), immune to catastrophic backtracking.

## Current state (v0.3.1)

**Working and shipped:**
- Multi-pattern DFA (2–9x faster than JS RegExp)
- `unicodeBoundaries: true` (default) — correct
  word boundaries for Czech/Arabic/Cyrillic with
  auto UAX#29 for Thai/CJK
- Zero-copy Buffer FFI path
- Lookaround support (strip-and-verify architecture)
- Split fast/slow DFA (prevents slow-path contamination)
- Named patterns (`{ pattern, name }`)
- 67 tests (49 unit + 18 property, 3400+ assertions)
- Exhaustive cartesian product test over all axes
  (options × patterns × flags × haystacks)
- Performance property test (catches DFA state explosions)

**Open PR #5** (`docs/update-benchmarks`):
- `(?i)` → `(?i-u)` fix (ASCII case folding for JS `/i`)
- `(?im-u)` flag ordering fix (was `(?i-um)` which disabled `m`)
- Updated benchmarks and README
- Needs merge after review

## Architecture

```
JS wrapper (lib.js / lib.mjs)
  ├── normalizeEntry()     — string/RegExp/NamedPattern → {pattern, name}
  ├── regexpToRust()       — /pattern/ims → (?ims-u)pattern
  ├── asciiBoundaries()    — \b → (?-u:\b) when unicodeBoundaries: false
  └── unpack()             — Uint32Array → Match[]

Rust engine (src/lib.rs)
  ├── strip_edge_boundaries() — strip leading/trailing \b/\B
  ├── build_verifier()        — strip lookaround → DFA core + Verifier
  ├── RegexSet::new()
  │   ├── Literal detection   — (currently disabled, see below)
  │   ├── Fast DFA            — Verifier::None patterns → find_iter
  │   ├── Slow DFA            — Verifier::Inline/Complex → manual loop
  │   └── Fallback            — fancy-regex for uncompilable patterns
  ├── collect_matches()       — single source of truth for all methods
  ├── boundary_mode()         — auto Inline vs UAX#29 Segmenter
  └── NAPI entry points       — Buffer (zero-copy) + String paths
```

**Pattern routing:**
1. `Verifier::None` + no `\B` → fast DFA (`find_iter`, single pass)
2. `Verifier::Inline` (simple `(?!\d)`) → slow DFA (manual loop)
3. `Verifier::Complex` (fancy `(?![...])`) → slow DFA + 40-byte window verify
4. MetaRegex can't compile → fancy-regex fallback (full scan)

**Boundary modes:**
- `unicodeBoundaries: false` → `(?-u:\b)` embedded in DFA (ASCII)
- `unicodeBoundaries: true` → `\b` stripped, verified inline per match
  - `is_alphanumeric()` for Latin/Arabic/Cyrillic (fast)
  - Auto UAX#29 bit set for Thai/CJK/Lao/Khmer/Myanmar
  - Detection via `needs_segmenter()` fast byte scan

## Performance profile

### Where we win (2–9x faster than JS)
- Multi-pattern (5+ patterns): single DFA pass vs N JS passes
- Word boundary patterns: strip-and-verify, zero DFA overhead
- Suffix/alternation patterns: DFA outperforms V8's NFA
- Production PII (16 patterns + /i + lookahead): 2.3x

### Where we lose
- Single literal on huge text (16MB "Twain"): 10x slower
  - Root cause: `memmem` Two-Way on ARM = 3GB/s
  - V8's Boyer-Moore-Horspool + NEON = 10GB/s
  - FFI overhead: Buffer.from + from_utf8 + unpack
- Single char class on huge text: 1.7x slower (same FFI issue)

### Where we tie
- Small texts (<1KB) with few patterns: FFI overhead ≈ JS overhead

## Known issues

### fancy-regex panics
Random pattern combinations trigger `index out of bounds`
in `fancy-regex` v0.14. Rust panics across FFI = process abort.
**Fix needed:** wrap NAPI entry points in `catch_unwind`.

### Performance property test flakiness
The 20x threshold catches real DFA explosions but can flake
on CI with slow-path patterns. May need further tuning.

## Next steps — AC prefilter architecture

The biggest remaining performance opportunity.

### The idea
For patterns with literal prefixes (most PII patterns:
`Ing.`, `Mgr.`, `+`, `@`, `/`, digit runs), extract the
prefixes and run Aho-Corasick in one SIMD-accelerated pass
to find candidate positions. Only run the DFA on small
windows (~100 bytes) around each candidate.

### Why it helps
- AC scans at SIMD speed (~20GB/s) for all prefixes simultaneously
- DFA only runs on candidate windows (1% of text)
- For 16 PII patterns on 64KB: AC finds ~50 candidates,
  DFA confirms on 50 × 100 bytes = 5KB instead of 64KB
- Estimated: 3–5x faster than current approach

### Implementation sketch
```
1. At construction:
   - Parse each pattern's regex AST (regex-syntax crate)
   - Extract literal prefix (first fixed bytes before any
     quantifier/alternation/class)
   - Build AhoCorasick from all prefixes
   - Store prefix→pattern mapping

2. At match time:
   - AC scans full text → candidate positions
   - For each candidate:
     - Determine which pattern(s) could match
     - Run individual MetaRegex on window [pos-20..pos+maxlen+20]
     - Verify boundaries/assertions
   - Merge, sort, select non-overlapping

3. Fallback:
   - Patterns without extractable literal prefix → current DFA path
   - Mix of prefixed + non-prefixed → AC for prefixed, DFA for rest
```

### Dependencies already in place
- `regex-syntax` crate (already a dependency via `regex-automata`)
  — provides `Hir` AST for prefix extraction
- `aho-corasick` crate (already a transitive dependency via `regex`)
  — or use `@stll/aho-corasick`'s Rust internals
- `memchr` crate (already added as dependency)

### Challenges
- Prefix extraction from regex AST (handling alternations,
  optional groups, character classes)
- Window sizing: need to know max possible match length
  per pattern (may be unbounded for `\w+`)
- Patterns with no literal prefix (e.g., `\d+`) can't use AC
- Coordination between AC hits and DFA confirmation
- UTF-8 boundary alignment for windows

### Would also fix
- The single-literal 16MB gap: AC with one pattern = memchr
  with optimal byte selection (the crate already does this,
  so the gain is specifically from windowed DFA for multi-pattern)

## Files

| File | Purpose |
|---|---|
| `src/lib.rs` | Rust engine (1300 lines) |
| `lib.js` | CJS wrapper |
| `lib.mjs` | ESM wrapper |
| `lib.d.ts` | User-facing TypeScript types |
| `index.js` | NAPI-RS generated bindings |
| `index.d.ts` | NAPI-RS generated types |
| `Cargo.toml` | Rust dependencies |
| `__test__/index.spec.ts` | 49 unit tests |
| `__test__/properties.spec.ts` | 18 property tests |
| `__bench__/speed.ts` | Academic benchmark suite |

## Key decisions and why

1. **`unicodeBoundaries: true` as default** — correct for all
   scripts out of the box. Czech legal text needs Unicode `\b`.

2. **Split fast/slow DFA** — 2 lookahead patterns in 16 were
   forcing all patterns through the O(n²) manual loop.

3. **`(?i-u)` not `(?i)`** — JS `/i` is ASCII case folding.
   Unicode case folding explodes DFA state count for
   month name alternations (15x regression).

4. **`(?ims-u)` flag ordering** — flags after `-` are disabled
   in Rust syntax. `(?i-um)` disables `m`.

5. **Complex verifiers stay in DFA** — fancy-regex full scan
   on 64KB was 42x slower. DFA + 40-byte window verify is fast.

6. **Buffer.from + from_utf8** — zero-copy FFI for small texts.
   On 16MB+, the copy overhead becomes visible but still
   beats the old NAPI string path.

## Bugs found during development (chronological)

| Bug | Caught by | Impact |
|---|---|---|
| `\b` + lookahead crash | User report | Blocked pipeline |
| Verifier::Complex wrong position | Greptile P1 | Silent false positives |
| Fallback pos advancement | Greptile P1 | Silent false negatives |
| DFA shadowing | Oracle property test | Silent false negatives |
| `from_utf8_unchecked` UB | Greptile P1 | Memory safety |
| Backslash escape counting | Greptile P1 | Pattern corruption |
| `wholeWords + \B` contradiction | Greptile P2 | Silent zero matches |
| Heterogeneous boundary shadowing | Greptile P1 | Silent false negatives |
| `(?i)` DFA state explosion | Production regression | 15x slower |
| `(?i-um)` disables `m` | Devin review | Silent wrong semantics |
| Slow-path contamination | Production regression | 12x slower |
| Complex → fallback regression | Production benchmark | 42x slower |
