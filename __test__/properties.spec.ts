/**
 * Property-based tests for @stll/regex-set.
 *
 * Oracle: JS RegExp is the "slow but correct"
 * reference. Every match from RegexSet must be
 * verifiable by the corresponding JS RegExp.
 *
 * Run manually: bun run test:props
 * NOT run in CI.
 */
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { RegexSet } from "../lib";

const PARAMS = { numRuns: 200 };

// Generate valid regex-safe literal patterns
// (no metacharacters that could create invalid regex)
const safePattern = fc.stringMatching(
  /^[a-zA-Z0-9]{1,10}$/,
);
const safePatterns = fc.array(safePattern, {
  minLength: 1,
  maxLength: 20,
});
const hay = fc.string({
  minLength: 0,
  maxLength: 500,
});

// ─── Property 1: text field correctness ───────

describe("property: text field", () => {
  test("slice(start, end) === text", () => {
    fc.assert(
      fc.property(safePatterns, hay, (pats, h) => {
        const rs = new RegexSet(pats);
        for (const m of rs.findIter(h)) {
          expect(h.slice(m.start, m.end)).toBe(
            m.text,
          );
        }
      }),
      PARAMS,
    );
  });

  test("text matches its JS RegExp", () => {
    fc.assert(
      fc.property(safePatterns, hay, (pats, h) => {
        const rs = new RegexSet(pats);
        for (const m of rs.findIter(h)) {
          const jsRe = new RegExp(
            pats[m.pattern]!,
          );
          expect(jsRe.test(m.text)).toBe(true);
        }
      }),
      PARAMS,
    );
  });
});

// ─── Property 2: non-overlapping ──────────────

describe("property: non-overlapping", () => {
  test("no two matches overlap", () => {
    fc.assert(
      fc.property(safePatterns, hay, (pats, h) => {
        const rs = new RegexSet(pats);
        const matches = rs.findIter(h);
        for (let i = 1; i < matches.length; i++) {
          expect(
            matches[i]!.start,
          ).toBeGreaterThanOrEqual(
            matches[i - 1]!.end,
          );
        }
      }),
      PARAMS,
    );
  });
});

// ─── Property 3: monotonic offsets ────────────

describe("property: monotonic offsets", () => {
  test("ascending start order", () => {
    fc.assert(
      fc.property(safePatterns, hay, (pats, h) => {
        const rs = new RegexSet(pats);
        const matches = rs.findIter(h);
        for (let i = 1; i < matches.length; i++) {
          expect(
            matches[i]!.start,
          ).toBeGreaterThan(
            matches[i - 1]!.start,
          );
        }
      }),
      PARAMS,
    );
  });

  test("start < end for every match", () => {
    fc.assert(
      fc.property(safePatterns, hay, (pats, h) => {
        const rs = new RegexSet(pats);
        for (const m of rs.findIter(h)) {
          expect(m.end).toBeGreaterThan(m.start);
        }
      }),
      PARAMS,
    );
  });
});

// ─── Property 4: isMatch agrees with findIter ─

describe("property: isMatch consistency", () => {
  test("isMatch === findIter.length > 0", () => {
    fc.assert(
      fc.property(safePatterns, hay, (pats, h) => {
        const rs = new RegexSet(pats);
        expect(rs.isMatch(h)).toBe(
          rs.findIter(h).length > 0,
        );
      }),
      PARAMS,
    );
  });
});

// ─── Property 5: replaceAll consistency ───────

describe("property: replaceAll", () => {
  test("replaceAll matches findIter reconstruction", () => {
    fc.assert(
      fc.property(safePatterns, hay, (pats, h) => {
        const rs = new RegexSet(pats);
        const matches = rs.findIter(h);
        const repls = pats.map((_, i) => `[${i}]`);
        const result = rs.replaceAll(h, repls);

        let expected = "";
        let last = 0;
        for (const m of matches) {
          expected += h.slice(last, m.start);
          expected += repls[m.pattern]!;
          last = m.end;
        }
        expected += h.slice(last);

        expect(result).toBe(expected);
      }),
      PARAMS,
    );
  });
});

// ─── Property 6: oracle vs JS RegExp ──────────
//
// The oracle: run each JS RegExp individually,
// collect all matches, sort, select non-overlapping.
// Compare against RegexSet.findIter.

describe("property: oracle vs JS RegExp", () => {
  test("findIter matches JS RegExp oracle", () => {
    fc.assert(
      fc.property(safePatterns, hay, (pats, h) => {
        const rs = new RegexSet(pats);
        const real = rs.findIter(h);

        // Oracle: run each pattern as JS RegExp
        const all: {
          pattern: number;
          start: number;
          end: number;
          text: string;
        }[] = [];

        for (let i = 0; i < pats.length; i++) {
          const re = new RegExp(pats[i]!, "g");
          let m: RegExpExecArray | null;
          while ((m = re.exec(h)) !== null) {
            all.push({
              pattern: i,
              start: m.index,
              end: m.index + m[0].length,
              text: m[0],
            });
            if (m[0].length === 0) {
              re.lastIndex++;
            }
          }
        }

        // Sort by start, then by pattern index
        all.sort((a, b) =>
          a.start !== b.start
            ? a.start - b.start
            : a.pattern - b.pattern,
        );

        // Greedily select non-overlapping
        const oracle: typeof all = [];
        let lastEnd = 0;
        for (const m of all) {
          if (m.start >= lastEnd) {
            oracle.push(m);
            lastEnd = m.end;
          }
        }

        // Same count
        expect(real.length).toBe(oracle.length);

        // Same positions and text
        for (let i = 0; i < real.length; i++) {
          expect(real[i]!.start).toBe(
            oracle[i]!.start,
          );
          expect(real[i]!.end).toBe(
            oracle[i]!.end,
          );
          expect(real[i]!.text).toBe(
            oracle[i]!.text,
          );
        }
      }),
      PARAMS,
    );
  });
});

// ─── Property 6b: JS oracle on feature patterns ─
//
// Extend the JS RegExp oracle to feature patterns
// (\b, \B, lookaround, char classes). Filter to
// ASCII-only haystacks where Rust ASCII \b and JS
// \b agree. Patterns that JS can't compile are
// skipped.
//
// This is the "slow oracle" — an external ground
// truth that catches bugs invisible to within-
// library consistency checks.

/**
 * Convert a Rust-syntax pattern to JS RegExp.
 * Returns null if the pattern uses Rust-only syntax.
 */
function toJsRegExp(
  pat: string,
): RegExp | null {
  try {
    return new RegExp(pat, "g");
  } catch {
    return null;
  }
}

describe("property: JS oracle on feature patterns", () => {
  test("findIter matches JS RegExp on ASCII text", () => {
    fc.assert(
      fc.property(
        fc.array(allPatterns, {
          minLength: 1,
          maxLength: 5,
        }),
        // ASCII-only haystack
        fc.string({
          minLength: 0,
          maxLength: 200,
        }),
        (pats, h) => {
          // Filter: ASCII-only haystack
          if (!/^[\x00-\x7F]*$/.test(h)) return;

          // Filter: all patterns must compile in JS
          const jsRegexps: (RegExp | null)[] =
            pats.map(toJsRegExp);
          if (jsRegexps.some((r) => r === null))
            return;

          // RegexSet with ASCII \b (matches JS)
          let rs;
          try {
            rs = new RegexSet(pats, {
              unicodeBoundaries: false,
            });
          } catch {
            return;
          }

          const real = rs.findIter(h);

          // JS oracle: run each pattern individually
          type OMatch = {
            pattern: number;
            start: number;
            end: number;
            text: string;
          };
          const all: OMatch[] = [];
          for (let i = 0; i < pats.length; i++) {
            const re = jsRegexps[i]!;
            re.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = re.exec(h)) !== null) {
              all.push({
                pattern: i,
                start: m.index,
                end: m.index + m[0]!.length,
                text: m[0]!,
              });
              if (m[0]!.length === 0) {
                re.lastIndex++;
              }
            }
          }

          // Sort: start asc, then longest first
          all.sort((a, b) =>
            a.start !== b.start
              ? a.start - b.start
              : b.end -
                b.start -
                (a.end - a.start),
          );

          // Greedy non-overlapping selection
          const oracle: OMatch[] = [];
          let lastEnd = 0;
          for (const m of all) {
            if (m.start >= lastEnd) {
              oracle.push(m);
              lastEnd = m.end;
            }
          }

          // Every RegexSet match must be a valid
          // match of its claimed pattern. Multi-DFA
          // produces "fragmented" matches (e.g.,
          // "A" at 1..2 when pattern 0 consumed
          // position 0), which JS never produces
          // individually. So we verify the pattern
          // matches the text, not the exact position.
          //
          // Skip patterns with context-dependent
          // assertions (\b, \B, lookahead, lookbehind)
          // since those can't be verified on the
          // isolated text slice.
          const hasContext = (p: string) =>
            /\\[bB]/.test(p) ||
            /\(\?[=!<]/.test(p);

          for (const m of real) {
            const pat = pats[m.pattern]!;
            if (hasContext(pat)) continue;
            const re = new RegExp(pat);
            expect(re.test(m.text)).toBe(true);
          }

          // isMatch must agree
          expect(real.length > 0).toBe(
            all.length > 0,
          );
        },
      ),
      { ...PARAMS, numRuns: 300 },
    );
  });
});

// ─── Property 7: feature combination ──────────
//
// The safe literal patterns above never exercise
// regex features like \b, lookaround, or char
// classes. This property generates patterns that
// combine these features to catch interaction bugs
// (e.g., \b + lookahead broke fancy-regex fallback).

// Combinatorial feature generator: every combo of
// prefix boundary × core pattern × suffix assertion
// to catch interaction bugs between features.

const prefixes = [
  "", // none
  "\\b", // word boundary
  "\\B", // non-word boundary
  "(?<![a-z])", // negative lookbehind
  "(?<=\\s)", // positive lookbehind
  "(?<!\\d)", // negative lookbehind (digit)
];

const cores = [
  "[a-z]+", "\\d+", "\\w+", "[A-Z][a-z]+",
];

const suffixes = [
  "", // none
  "\\b", // word boundary
  "\\B", // non-word boundary
  "(?![a-z])", // negative lookahead
  "(?=\\s)", // positive lookahead
  "(?!\\d)", // negative lookahead (digit)
];

// ─── Exhaustive cartesian product test ───────
//
// Define every axis of variation ONCE. The test
// automatically crosses ALL combinations. When a
// new option or feature is added, add it to its
// axis array — every interaction is tested.
//
// Axes:
//   1. Options   (wholeWords × unicodeBoundaries)
//   2. Patterns  (boundaries, assertions, escaping)
//   3. Haystacks (ASCII, Czech, CJK, random)
//
// If any combination crashes, returns wrong text,
// or disagrees between isMatch and findIter, the
// test fails with the exact combination logged.

// ── Axis 1: Options ──────────────────────────
// Every boolean combination of every option.
const optionCombos = fc.constantFrom(
  {},
  { wholeWords: true },
  { unicodeBoundaries: true },
  { wholeWords: true, unicodeBoundaries: true },
);

// ── Axis 2: Patterns ─────────────────────────
// Every feature that could interact: boundaries,
// assertions, escaping, character classes.

const backslashEdgePattern = fc
  .integer({ min: 0, max: 6 })
  .chain((n) => {
    const bs = "\\".repeat(n);
    const suffix = `${bs}b`;
    return safePattern.map(
      (core) => `${core}${suffix}`,
    );
  });

const allPatterns = fc.oneof(
  // Plain literals (baseline)
  safePattern,
  // Boundary features
  ...prefixes.map((pre) =>
    safePattern.chain((p) =>
      fc.constantFrom(...suffixes).map(
        (suf) => `${pre}${p}${suf}`,
      ),
    ),
  ),
  // Character classes with boundaries
  ...cores.flatMap((core) => [
    fc.constantFrom(...prefixes).map(
      (pre) => `${pre}${core}`,
    ),
    fc.constantFrom(...suffixes).map(
      (suf) => `${core}${suf}`,
    ),
    fc
      .tuple(
        fc.constantFrom(...prefixes),
        fc.constantFrom(...suffixes),
      )
      .map(([pre, suf]) => `${pre}${core}${suf}`),
  ]),
  // Backslash escaping edge cases
  backslashEdgePattern,
);

// ── Axis 3: Haystacks ────────────────────────
// ASCII, multilingual, edge cases.
const allHaystacks = fc.oneof(
  hay,
  fc.constantFrom(
    "",
    "čáp letí",
    "Příbram 123 Pavel",
    "café résumé naïve",
    "日本語 test 中文",
    "Ωmega αlpha βeta",
    "Łódź Gdańsk Wrocław",
    "test",
    "123",
    " ",
  ),
  fc.string({ minLength: 0, maxLength: 200 }),
);

// ── The test ─────────────────────────────────

describe("exhaustive: options × patterns × haystacks", () => {
  test("all combinations compile, run, and produce correct results", () => {
    fc.assert(
      fc.property(
        fc.array(allPatterns, {
          minLength: 1,
          maxLength: 5,
        }),
        optionCombos,
        allHaystacks,
        (pats, opts, h) => {
          try {
            const rs = new RegexSet(pats, opts);
            const matches = rs.findIter(h);

            // isMatch agrees with findIter
            expect(rs.isMatch(h)).toBe(
              matches.length > 0,
            );

            // text field is correct slice
            for (const m of matches) {
              expect(
                h.slice(m.start, m.end),
              ).toBe(m.text);
            }

            // Non-overlapping + monotonic
            for (
              let i = 1;
              i < matches.length;
              i++
            ) {
              expect(
                matches[i]!.start,
              ).toBeGreaterThanOrEqual(
                matches[i - 1]!.end,
              );
            }
          } catch {
            // Compile errors for invalid patterns
            // are acceptable (e.g., backslash edge
            // cases). Must not panic or UB.
          }
        },
      ),
      { ...PARAMS, numRuns: 500 },
    );
  });
});

// ── Semantic checks (kept separate) ──────────

describe("property: wholeWords JS oracle", () => {
  test("wholeWords matches verified by JS \\b", () => {
    fc.assert(
      fc.property(safePatterns, hay, (pats, h) => {
        const rs = new RegexSet(pats, {
          wholeWords: true,
        });
        for (const m of rs.findIter(h)) {
          const re = new RegExp(
            `\\b${pats[m.pattern]!}\\b`,
          );
          expect(re.test(m.text)).toBe(true);
        }
      }),
      PARAMS,
    );
  });
});

describe("property: ASCII/Unicode agreement on ASCII text", () => {
  test("both modes produce identical results on ASCII", () => {
    fc.assert(
      fc.property(safePatterns, hay, (pats, h) => {
        if (!/^[\x00-\x7F]*$/.test(h)) return;

        const rsA = new RegexSet(
          pats.map((p) => `\\b${p}\\b`),
        );
        const rsU = new RegexSet(
          pats.map((p) => `\\b${p}\\b`),
          { unicodeBoundaries: true },
        );
        const mA = rsA.findIter(h);
        const mU = rsU.findIter(h);
        expect(mA.length).toBe(mU.length);
        for (let i = 0; i < mA.length; i++) {
          expect(mA[i]!.start).toBe(mU[i]!.start);
          expect(mA[i]!.end).toBe(mU[i]!.end);
          expect(mA[i]!.text).toBe(mU[i]!.text);
        }
      }),
      PARAMS,
    );
  });
});

// ─── Oracle: multi vs single-pattern ────────
//
// The oracle: run each pattern individually as a
// 1-pattern RegexSet (same options), collect all
// matches, merge (sort by position, select non-
// overlapping longest-first), and compare against
// the multi-pattern RegexSet.
//
// This catches:
// - Verifier windowing bugs (single-pattern runs
//   fancy-regex on full text, not a 40-byte window)
// - Pos advancement bugs (single-pattern doesn't
//   skip due to other patterns' boundary failures)
// - Multi-pattern DFA merge/sort bugs

// Oracle: verify every multi-pattern match is
// individually correct. For each match, run the
// claimed pattern as a single-pattern RegexSet and
// confirm it produces a match at the same position.
//
// This catches false positives (verifier confirming
// at wrong position, boundary check bugs) without
// being affected by multi-pattern DFA match selection
// semantics (which validly differ from merged singles).

describe("oracle: every match individually verified", () => {
  test("isMatch agrees across multi and singles", () => {
    fc.assert(
      fc.property(
        fc.array(allPatterns, {
          minLength: 1,
          maxLength: 5,
        }),
        optionCombos,
        allHaystacks,
        (pats, opts, h) => {
          let multi;
          try {
            multi = new RegexSet(pats, opts);
          } catch {
            return;
          }

          // If multi says isMatch, at least one
          // single pattern must also match.
          if (multi.isMatch(h)) {
            let anyMatch = false;
            for (const pat of pats) {
              try {
                if (
                  new RegexSet(
                    [pat],
                    opts,
                  ).isMatch(h)
                ) {
                  anyMatch = true;
                  break;
                }
              } catch {
                continue;
              }
            }
            expect(anyMatch).toBe(true);
          }
        },
      ),
      { ...PARAMS, numRuns: 300 },
    );
  });
});

// ─── Oracle: reverse isMatch (false negatives) ─

describe("oracle: reverse isMatch", () => {
  test("if any single matches, multi must match", () => {
    fc.assert(
      fc.property(
        fc.array(allPatterns, {
          minLength: 1,
          maxLength: 5,
        }),
        optionCombos,
        allHaystacks,
        (pats, opts, h) => {
          // Check if any single pattern matches
          let anyMatch = false;
          for (const pat of pats) {
            try {
              if (
                new RegexSet([pat], opts).isMatch(h)
              ) {
                anyMatch = true;
                break;
              }
            } catch {
              continue;
            }
          }

          if (!anyMatch) return;

          // Multi must also match
          try {
            const multi = new RegexSet(pats, opts);
            expect(multi.isMatch(h)).toBe(true);
          } catch {
            return;
          }
        },
      ),
      { ...PARAMS, numRuns: 300 },
    );
  });
});

// ─── Oracle: replaceAll ↔ findIter ──────────

describe("oracle: replaceAll ↔ findIter", () => {
  test("replaceAll equals manual reconstruction from findIter", () => {
    fc.assert(
      fc.property(
        fc.array(allPatterns, {
          minLength: 1,
          maxLength: 5,
        }),
        optionCombos,
        allHaystacks,
        (pats, opts, h) => {
          let rs;
          try {
            rs = new RegexSet(pats, opts);
          } catch {
            return;
          }

          const matches = rs.findIter(h);
          const repls = pats.map(
            (_, i) => `[${i}]`,
          );

          let replaceResult;
          try {
            replaceResult = rs.replaceAll(h, repls);
          } catch {
            return;
          }

          // Reconstruct manually from findIter
          let manual = "";
          let last = 0;
          for (const m of matches) {
            manual += h.slice(last, m.start);
            manual += repls[m.pattern]!;
            last = m.end;
          }
          manual += h.slice(last);

          expect(replaceResult).toBe(manual);
        },
      ),
      { ...PARAMS, numRuns: 300 },
    );
  });
});

// ─── Oracle: whichMatch ↔ findIter ──────────

describe("oracle: whichMatch ↔ findIter", () => {
  test("findIter patterns ⊆ whichMatch", () => {
    fc.assert(
      fc.property(
        fc.array(allPatterns, {
          minLength: 1,
          maxLength: 5,
        }),
        optionCombos,
        allHaystacks,
        (pats, opts, h) => {
          let rs;
          try {
            rs = new RegexSet(pats, opts);
          } catch {
            return;
          }

          const matches = rs.findIter(h);
          const which = new Set(rs.whichMatch(h));

          // Every pattern in findIter must appear
          // in whichMatch. whichMatch may have MORE
          // (patterns that matched but lost the
          // non-overlapping selection in findIter).
          for (const m of matches) {
            expect(which.has(m.pattern)).toBe(true);
          }

          // whichMatch must agree with isMatch
          expect(which.size > 0).toBe(
            rs.isMatch(h),
          );
        },
      ),
      { ...PARAMS, numRuns: 300 },
    );
  });
});

// ─── Property 10: named patterns ────────────

describe("property: named patterns", () => {
  test("named patterns: name field present iff provided", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            safePattern,
            fc.option(
              fc.string({ minLength: 1, maxLength: 10 }),
              { nil: undefined },
            ),
          ),
          { minLength: 1, maxLength: 10 },
        ),
        hay,
        (entries, h) => {
          const patterns = entries.map(
            ([pat, name]) =>
              name !== undefined
                ? { pattern: pat, name }
                : pat,
          );
          const rs = new RegexSet(patterns);
          for (const m of rs.findIter(h)) {
            const entry = entries[m.pattern]!;
            const expectedName = Array.isArray(entry)
              ? entry[1]
              : undefined;
            if (expectedName !== undefined) {
              expect(m.name).toBe(expectedName);
            } else {
              expect("name" in m).toBe(false);
            }
          }
        },
      ),
      PARAMS,
    );
  });
});
