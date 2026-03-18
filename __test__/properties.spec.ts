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

// Build all prefix × core × suffix combinations
const combos: string[] = [];
for (const pre of prefixes) {
  for (const core of cores) {
    for (const suf of suffixes) {
      combos.push(`${pre}${core}${suf}`);
    }
  }
}

// Pick random combos per test run
const featurePattern = fc.oneof(
  // Static combos (all feature interactions)
  ...combos.map((c) => fc.constant(c)),
  // Dynamic: safe literal with random boundary/assertion
  safePattern.chain((p) =>
    fc.tuple(
      fc.constantFrom(...prefixes),
      fc.constantFrom(...suffixes),
    ).map(([pre, suf]) => `${pre}${p}${suf}`),
  ),
);

// ─── Property 7b: backslash escaping ─────────
//
// Varying counts of backslashes before 'b' at
// pattern edges to catch escape-counting bugs.
// Odd count = \b (word boundary), even = \\b
// (literal backslash + b).

const backslashEdgePattern = fc
  .integer({ min: 0, max: 6 })
  .chain((n) => {
    // n backslashes before 'b' at the end
    const bs = "\\".repeat(n);
    const suffix = `${bs}b`;
    // Only valid regex if n is even (literal \...\b)
    // or n is odd (word boundary).
    // Pair with a safe core that always matches.
    return safePattern.map((core) => {
      // For even n: pattern ends with literal
      // backslash(es) + b. For odd n: word boundary.
      return `${core}${suffix}`;
    });
  });

describe("property: backslash escaping", () => {
  test("patterns with 0-6 backslashes before b compile or throw consistently", () => {
    fc.assert(
      fc.property(
        backslashEdgePattern,
        hay,
        (pat, h) => {
          try {
            const rs = new RegexSet([pat]);
            const matches = rs.findIter(h);
            // If it compiles, text field must be
            // correct
            for (const m of matches) {
              expect(h.slice(m.start, m.end)).toBe(
                m.text,
              );
            }
          } catch {
            // Invalid regex is acceptable — just
            // must not panic or corrupt state
          }
        },
      ),
      PARAMS,
    );
  });
});

describe("property: feature combinations", () => {
  test("all boundary × assertion combos compile and run", () => {
    fc.assert(
      fc.property(
        fc.array(featurePattern, {
          minLength: 1,
          maxLength: 5,
        }),
        hay,
        (pats, h) => {
          // Must not throw
          const rs = new RegexSet(pats);
          // isMatch and findIter must agree
          const matches = rs.findIter(h);
          expect(rs.isMatch(h)).toBe(
            matches.length > 0,
          );
          // text field must be correct
          for (const m of matches) {
            expect(h.slice(m.start, m.end)).toBe(
              m.text,
            );
          }
        },
      ),
      PARAMS,
    );
  });
});

// ─── Property 8: wholeWords consistency ───────

describe("property: wholeWords", () => {
  test("wholeWords matches have \\b boundaries", () => {
    fc.assert(
      fc.property(safePatterns, hay, (pats, h) => {
        const rs = new RegexSet(pats, {
          wholeWords: true,
        });
        for (const m of rs.findIter(h)) {
          // Verify with JS \b
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

// ─── Property 8b: option × feature cross ─────
//
// Every combination of options (wholeWords,
// unicodeBoundaries) × pattern features (\b, \B,
// lookaround) must compile and not panic/UB.

const allOptions = fc.constantFrom(
  {},
  { wholeWords: true },
  { unicodeBoundaries: true },
  { wholeWords: true, unicodeBoundaries: true },
);

describe("property: option × feature cross", () => {
  test("all option combos × pattern features compile", () => {
    fc.assert(
      fc.property(
        fc.array(featurePattern, {
          minLength: 1,
          maxLength: 5,
        }),
        allOptions,
        hay,
        (pats, opts, h) => {
          // Must not throw or panic
          const rs = new RegexSet(pats, opts);
          const matches = rs.findIter(h);
          expect(rs.isMatch(h)).toBe(
            matches.length > 0,
          );
          for (const m of matches) {
            expect(h.slice(m.start, m.end)).toBe(
              m.text,
            );
          }
        },
      ),
      PARAMS,
    );
  });
});

// ─── Property 9: unicodeBoundaries ──────────
//
// When unicodeBoundaries is true, \b must treat
// Unicode letters as word characters. Verify
// consistency between ASCII and Unicode modes.

// Haystack with mixed ASCII + non-ASCII words
const unicodeHay = fc.oneof(
  hay,
  fc.constantFrom(
    "čáp letí",
    "Příbram 123 Pavel",
    "café résumé naïve",
    "日本語 test 中文",
    "Ωmega αlpha βeta",
    "Łódź Gdańsk Wrocław",
  ),
  fc.string({ minLength: 0, maxLength: 200 }),
);

describe("property: unicodeBoundaries", () => {
  test("unicode mode: all combos compile and run", () => {
    fc.assert(
      fc.property(
        fc.array(featurePattern, {
          minLength: 1,
          maxLength: 5,
        }),
        unicodeHay,
        (pats, h) => {
          const rs = new RegexSet(pats, {
            unicodeBoundaries: true,
          });
          const matches = rs.findIter(h);
          expect(rs.isMatch(h)).toBe(
            matches.length > 0,
          );
          for (const m of matches) {
            expect(h.slice(m.start, m.end)).toBe(
              m.text,
            );
          }
        },
      ),
      PARAMS,
    );
  });

  test("wholeWords + unicode: no crash, text correct", () => {
    fc.assert(
      fc.property(
        safePatterns,
        unicodeHay,
        (pats, h) => {
          const rs = new RegexSet(pats, {
            wholeWords: true,
            unicodeBoundaries: true,
          });
          const matches = rs.findIter(h);
          expect(rs.isMatch(h)).toBe(
            matches.length > 0,
          );
          for (const m of matches) {
            expect(h.slice(m.start, m.end)).toBe(
              m.text,
            );
          }
        },
      ),
      PARAMS,
    );
  });

  test("ASCII and Unicode modes agree on ASCII-only text", () => {
    // On pure ASCII text, both modes should produce
    // identical results.
    fc.assert(
      fc.property(safePatterns, hay, (pats, h) => {
        // Ensure ASCII-only haystack
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
