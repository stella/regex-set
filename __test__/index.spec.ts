import { describe, expect, test } from "bun:test";

import { RegexSet } from "../src/index";

describe("RegexSet", () => {
  test("basic matching", () => {
    const rs = new RegexSet(["foo", "bar"]);
    expect(rs.patternCount).toBe(2);
    expect(rs.isMatch("hello foo")).toBe(true);
    expect(rs.isMatch("xyz")).toBe(false);
  });

  test("findIter returns correct matches", () => {
    const rs = new RegexSet(["foo", "bar"]);
    const matches = rs.findIter("foo bar foo");

    expect(matches).toEqual([
      {
        pattern: 0,
        start: 0,
        end: 3,
        text: "foo",
      },
      {
        pattern: 1,
        start: 4,
        end: 7,
        text: "bar",
      },
      {
        pattern: 0,
        start: 8,
        end: 11,
        text: "foo",
      },
    ]);
  });

  test("regex patterns: dates", () => {
    const rs = new RegexSet(["\\d{2}\\.\\d{2}\\.\\d{4}"]);
    const matches = rs.findIter(
      "Born 15.03.1990 in Prague",
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toBe("15.03.1990");
  });

  test("regex patterns: phone numbers", () => {
    const rs = new RegexSet(["\\+?\\d{9,12}"]);
    const matches = rs.findIter(
      "Call +420123456789 or 123456789",
    );

    expect(matches).toHaveLength(2);
    expect(matches[0]!.text).toBe("+420123456789");
    expect(matches[1]!.text).toBe("123456789");
  });

  test("regex patterns: IDs", () => {
    const rs = new RegexSet(["[A-Z]{2}\\d{6}"]);
    const matches = rs.findIter(
      "ID: CZ123456, passport AB654321",
    );

    expect(matches).toHaveLength(2);
    expect(matches[0]!.text).toBe("CZ123456");
    expect(matches[1]!.text).toBe("AB654321");
  });

  test("multi-pattern in single pass", () => {
    const rs = new RegexSet([
      "\\d{2}\\.\\d{2}\\.\\d{4}",
      "\\+?\\d{9,12}",
      "[A-Z]{2}\\d{6}",
      "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+",
    ]);
    const text =
      "Jan, born 15.03.1990, ID CZ123456, " +
      "email jan@example.com, phone +420123456789";
    const matches = rs.findIter(text);

    expect(matches).toHaveLength(4);
    const texts = matches.map((m) => m.text);
    expect(texts).toContain("15.03.1990");
    expect(texts).toContain("CZ123456");
    expect(texts).toContain("jan@example.com");
    expect(texts).toContain("+420123456789");
  });

  test("whichMatch returns pattern indices", () => {
    const rs = new RegexSet(["foo", "bar", "baz"]);
    const which = rs.whichMatch("foo and baz");
    expect(which).toContain(0);
    expect(which).toContain(2);
    expect(which).not.toContain(1);
  });

  test("replaceAll", () => {
    const rs = new RegexSet([
      "\\d{2}\\.\\d{2}\\.\\d{4}",
      "\\+?\\d{9,12}",
    ]);
    const result = rs.replaceAll(
      "Born 15.03.1990, phone +420123456789",
      ["[DATE]", "[PHONE]"],
    );
    expect(result).toBe("Born [DATE], phone [PHONE]");
  });

  test("replaceAll throws on wrong count", () => {
    const rs = new RegexSet(["a", "b"]);
    expect(() => rs.replaceAll("ab", ["x"])).toThrow();
  });

  test("empty patterns", () => {
    const rs = new RegexSet([]);
    expect(rs.patternCount).toBe(0);
    expect(rs.isMatch("anything")).toBe(false);
    expect(rs.findIter("anything")).toEqual([]);
  });

  test("empty haystack", () => {
    const rs = new RegexSet(["test"]);
    expect(rs.isMatch("")).toBe(false);
    expect(rs.findIter("")).toEqual([]);
  });

  test("invalid regex throws", () => {
    expect(() => new RegexSet(["[invalid"])).toThrow(
      /Failed to compile/,
    );
  });

  test("no catastrophic backtracking", () => {
    // This would hang a JS RegExp engine
    const rs = new RegexSet(["(a+)+b"]);
    const start = performance.now();
    rs.isMatch("a".repeat(30) + "c");
    const elapsed = performance.now() - start;

    // Rust regex guarantees O(n), should be < 10ms
    expect(elapsed).toBeLessThan(100);
  });
});

// ─── wholeWords ───────────────────────────────

describe("wholeWords", () => {
  test("basic whole word filtering", () => {
    const rs = new RegexSet(["\\d+"], {
      wholeWords: true,
    });
    // "123" inside "abc123def" is NOT a whole word
    expect(rs.findIter("abc123def").length).toBe(0);
    // "123" surrounded by spaces IS
    expect(rs.findIter("abc 123 def").length).toBe(1);
  });

  test("regex pattern with wholeWords", () => {
    const rs = new RegexSet(["\\d{2}\\.\\d{2}\\.\\d{4}"], {
      wholeWords: true,
    });
    const matches = rs.findIter("date 15.03.1990 ok");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toBe("15.03.1990");

    // Not a whole word if glued to text
    expect(rs.findIter("date15.03.1990ok").length).toBe(0);
  });

  test("wholeWords with literal patterns", () => {
    const rs = new RegexSet(["test"], {
      wholeWords: true,
    });
    expect(rs.findIter("testing").length).toBe(0);
    expect(rs.findIter("a test b").length).toBe(1);
  });

  test("without wholeWords (default)", () => {
    const rs = new RegexSet(["\\d+"]);
    expect(rs.findIter("abc123def").length).toBe(1);
  });
});

// ─── Unicode offsets ──────────────────────────

describe("unicode offsets", () => {
  test("emoji in haystack", () => {
    const rs = new RegexSet(["\\d+"]);
    const text = "🔥 123 🎉";
    const matches = rs.findIter(text);

    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toBe("123");
    // 🔥 = 2 UTF-16 units, space = 1
    expect(matches[0]!.start).toBe(3);
  });

  test("CJK in haystack", () => {
    const rs = new RegexSet(["\\d+"]);
    const text = "有限公司123";
    const matches = rs.findIter(text);

    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toBe("123");
    expect(matches[0]!.start).toBe(4);
  });

  test("diacritics", () => {
    const rs = new RegexSet(["\\d{8}"]);
    const text = "IČO: 12345678";
    const matches = rs.findIter(text);

    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toBe("12345678");
  });

  test("mixed multi-byte", () => {
    const rs = new RegexSet(["target"]);
    const text = "é有🔥target";
    const matches = rs.findIter(text);

    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toBe("target");
    expect(matches[0]!.start).toBe(4);
  });
});

// ─── ASCII word boundary performance ─────────
// Regression: \b patterns were 10x slower than JS
// due to Rust using Unicode word boundaries.

describe("ascii word boundary", () => {
  test("\\b in string patterns uses ASCII boundary", () => {
    const rs = new RegexSet(["\\bJan\\b", "\\bPavel\\b"]);
    const matches = rs.findIter("Jan met Pavel in Prague");
    expect(matches).toHaveLength(2);
    expect(matches[0]!.text).toBe("Jan");
    expect(matches[1]!.text).toBe("Pavel");
  });

  test("\\b in RegExp patterns uses ASCII boundary", () => {
    const rs = new RegexSet([/\bfoo\b/, /\bbar\b/]);
    const matches = rs.findIter("foo met bar");
    expect(matches).toHaveLength(2);
    expect(matches[0]!.text).toBe("foo");
    expect(matches[1]!.text).toBe("bar");
  });

  test("\\B (non-word-boundary) uses ASCII semantics", () => {
    const rs = new RegexSet(["\\Btest\\B"]);
    const matches = rs.findIter("atesting");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toBe("test");
    // Should not match at word boundary
    expect(rs.findIter("test").length).toBe(0);
  });

  test("\\b inside character class is preserved", () => {
    // [\b] means backspace in regex, not word boundary
    // Should not be replaced with (?-u:\b)
    const rs = new RegexSet(["[\\b]"]);
    // Should compile without error (no invalid syntax)
    expect(rs.patternCount).toBe(1);
  });

  test("escaped backslash before b is preserved", () => {
    // \\b means literal backslash + letter b
    const rs = new RegexSet(["\\\\b"]);
    const matches = rs.findIter("a\\b");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toBe("\\b");
  });

  test("multiple escaped backslashes before b", () => {
    // \\\\b = two literal backslashes + letter b
    // Must NOT be stripped as a word boundary
    const rs = new RegexSet(["\\\\\\\\b"]);
    const matches = rs.findIter("a\\\\b");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toBe("\\\\b");
  });

  test("odd backslashes before b is word boundary", () => {
    // \\\b = literal backslash + word boundary
    const rs = new RegexSet(["\\\\\\btest\\b"]);
    const matches = rs.findIter("\\test done");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toBe("\\test");
  });

  test("\\b perf: no catastrophic slowdown", () => {
    // Loose threshold (500ms) to catch only
    // catastrophic regressions (Unicode \b would
    // take 10x+), not CI noise.
    const text = "a".repeat(100_000);
    const rs = new RegexSet(["\\btest\\b"]);
    const start = performance.now();
    rs.findIter(text);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  test("\\b + lookahead combination works", () => {
    // Regression: (?-u:\b) broke fancy-regex fallback
    const rs = new RegexSet([String.raw`\b\d{3}(?!\d)\b`]);
    const matches = rs.findIter("abc 123 def 4567");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toBe("123");
    // 4567 should NOT match (lookahead rejects)
  });

  test("\\b + lookbehind + lookahead works", () => {
    // Both assertions prevent inline extraction,
    // forcing the fancy-regex fallback path.
    const rs = new RegexSet([
      String.raw`\b(?<!\d)\d{3}(?!\d)\b`,
    ]);
    const matches = rs.findIter("abc 123 def 4567");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toBe("123");
  });

  test("\\b + lookahead in phone pattern", () => {
    // The exact pattern from the bug report
    const rs = new RegexSet([
      String.raw`\b(?:[2-578]\d|60)\d[\s.\-]?\d{3}[\s.\-]?\d{3}(?!\d)\b`,
    ]);
    expect(rs.isMatch("601 234 567")).toBe(true);
    expect(rs.isMatch("601234567")).toBe(true);
    expect(rs.isMatch("6012345678")).toBe(false);
  });

  test("wholeWords perf: uses ASCII boundary", () => {
    const rs = new RegexSet(["test"], {
      wholeWords: true,
    });
    const text = "x".repeat(100_000);
    const start = performance.now();
    rs.findIter(text);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
  });
});

// ─── Unicode word boundaries ─────────────────

describe("unicodeBoundaries", () => {
  test("čáp: ASCII \\b treats p as standalone", () => {
    // ASCII \b: č and á are NOT word chars
    const rs = new RegexSet(["\\bp\\b"], {
      unicodeBoundaries: false,
    });
    expect(rs.findIter("čáp")).toHaveLength(1);
    expect(rs.findIter("čáp")[0]!.text).toBe("p");
  });

  test("čáp: Unicode \\b treats čáp as one word", () => {
    // Unicode \b: č and á ARE word chars
    const rs = new RegexSet(["\\bp\\b"], {
      unicodeBoundaries: true,
    });
    // p is NOT at a word boundary — čáp is one word
    expect(rs.findIter("čáp")).toHaveLength(0);
  });

  test("Unicode \\b matches whole Czech word", () => {
    const rs = new RegexSet(["\\bčáp\\b"], {
      unicodeBoundaries: true,
    });
    expect(rs.findIter("malý čáp letí")).toHaveLength(1);
    expect(rs.findIter("malý čáp letí")[0]!.text).toBe(
      "čáp",
    );
    // Should not match inside another word
    expect(rs.findIter("čápek")).toHaveLength(0);
  });

  test("wholeWords + unicodeBoundaries", () => {
    const rs = new RegexSet(["Pavel", "Příbram"], {
      wholeWords: true,
      unicodeBoundaries: true,
    });
    const text = "Pavel je z Příbrami";
    const matches = rs.findIter(text);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toBe("Pavel");
    // Příbrami ≠ Příbram (not whole word)
  });

  test("Unicode \\b + lookahead works", () => {
    const rs = new RegexSet([String.raw`\b\d{3}(?!\d)\b`], {
      unicodeBoundaries: true,
    });
    const matches = rs.findIter("abc 123 def 4567");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toBe("123");
  });

  test("Unicode \\b perf: no DFA overhead", () => {
    const rs = new RegexSet(["\\btest\\b"], {
      unicodeBoundaries: true,
    });
    const text = "a".repeat(100_000);
    const start = performance.now();
    rs.findIter(text);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
  });
});

// ─── (?i) string patterns with \b ────────────

describe("(?i) string + \\b parity", () => {
  test("string (?i)\\b matches like RegExp /\\b/i", () => {
    // Both paths should produce Unicode \b semantics
    // when unicodeBoundaries is true.
    const strRs = new RegexSet(["(?i)\\bjanuar\\b"], {
      unicodeBoundaries: true,
    });
    const reRs = new RegexSet([/\bjanuar\b/i], {
      unicodeBoundaries: true,
    });

    const text = "15. Januar 2025";
    const strM = strRs.findIter(text);
    const reM = reRs.findIter(text);

    expect(strM).toHaveLength(1);
    expect(reM).toHaveLength(1);
    expect(strM[0]!.text).toBe("Januar");
    expect(reM[0]!.text).toBe("Januar");
  });

  test("(?i)\\b preserves Unicode boundary semantics", () => {
    // čáp is one word in Unicode — \b should not
    // fire between á and p. If -u leaked to \b,
    // it would fire (ASCII \b treats á as non-word).
    const rs = new RegexSet(["(?i)\\bp\\b"], {
      unicodeBoundaries: true,
    });
    // Should NOT match: čáp is one Unicode word
    expect(rs.findIter("čáp")).toHaveLength(0);
  });

  test("(?i) without \\b still gets -u scoping", () => {
    // Case-insensitive matching should work
    const rs = new RegexSet(["(?i)januar"]);
    expect(rs.isMatch("JANUAR")).toBe(true);
    expect(rs.isMatch("Januar")).toBe(true);
    expect(rs.isMatch("januar")).toBe(true);
  });

  test("mid-pattern bare (?i) gets -u scoping", () => {
    // (?i) in the middle of a pattern sets case-
    // insensitive mode for the rest of the pattern.
    const rs = new RegexSet(["\\d{2}\\.(?i)januar"]);
    expect(rs.isMatch("15.Januar")).toBe(true);
    expect(rs.isMatch("15.JANUAR")).toBe(true);
    expect(rs.isMatch("15.januar")).toBe(true);
    // Digits before the (?i) are not affected
    expect(rs.isMatch("AB.januar")).toBe(false);
  });

  test("(?i-s:...) combined flags get -u scoping", () => {
    // (?i-s:...) enables i, disables s — should
    // also get -u for ASCII case folding.
    const rs = new RegexSet(["(?i-s:januar)"]);
    expect(rs.isMatch("JANUAR")).toBe(true);
    expect(rs.isMatch("januar")).toBe(true);
  });

  test("bare (?i-s) at start gets -u scoping", () => {
    const rs = new RegexSet(["(?i-s)\\bjanuar\\b"], {
      unicodeBoundaries: true,
    });
    expect(rs.isMatch("Januar")).toBe(true);
    expect(rs.isMatch("JANUAR")).toBe(true);
  });
});

// ─── Heterogeneous boundary shadowing ────────

describe("heterogeneous boundaries", () => {
  test("\\bfoo\\b + \\bfoo\\B: second matches in foobar", () => {
    // Pattern 0: \bfoo\b (trailing word boundary)
    // Pattern 1: \bfoo\B (trailing non-word-boundary)
    // On "foobar": foo at 0..3, trailing is o|b
    // (both word chars) → \b fails, \B passes.
    // Pattern 1 should match.
    const rs = new RegexSet(["\\bfoo\\b", "\\bfoo\\B"], {
      unicodeBoundaries: true,
    });
    const matches = rs.findIter("foobar");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.pattern).toBe(1);
    expect(matches[0]!.text).toBe("foo");
  });

  test("\\bfoo\\b + \\bfoo\\B: first matches in foo bar", () => {
    const rs = new RegexSet(["\\bfoo\\b", "\\bfoo\\B"], {
      unicodeBoundaries: true,
    });
    const matches = rs.findIter("foo bar");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.pattern).toBe(0);
    expect(matches[0]!.text).toBe("foo");
  });
});

// ─── Named patterns ─────────────────────────

describe("named patterns", () => {
  test("named pattern adds name to match", () => {
    const rs = new RegexSet([
      { pattern: "\\d+", name: "number" },
      { pattern: "[a-z]+", name: "word" },
    ]);
    const matches = rs.findIter("abc 123");
    expect(matches).toHaveLength(2);
    expect(matches[0]!.name).toBe("word");
    expect(matches[1]!.name).toBe("number");
  });

  test("named pattern with RegExp", () => {
    const rs = new RegexSet([
      { pattern: /\d{2}\.\d{2}\.\d{4}/, name: "date" },
    ]);
    const matches = rs.findIter("Born 15.03.1990");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.name).toBe("date");
    expect(matches[0]!.text).toBe("15.03.1990");
  });

  test("unnamed patterns have no name property", () => {
    const rs = new RegexSet(["\\d+", "[a-z]+"]);
    const matches = rs.findIter("abc 123");
    for (const m of matches) {
      expect("name" in m).toBe(false);
    }
  });

  test("mixed named+unnamed: name absent on unnamed", () => {
    const rs = new RegexSet([
      { pattern: /\d+/, name: "num" },
      /[a-z]+/, // unnamed
    ]);
    const matches = rs.findIter("a1");
    const named = matches.find((m) => m.pattern === 0)!;
    const unnamed = matches.find((m) => m.pattern === 1)!;
    expect(named.name).toBe("num");
    expect("name" in unnamed).toBe(false);
  });

  test("patternCount with named patterns", () => {
    const rs = new RegexSet([
      { pattern: "a", name: "first" },
      { pattern: "b", name: "second" },
    ]);
    expect(rs.patternCount).toBe(2);
  });

  test("invalid pattern type in NamedPattern throws", () => {
    expect(
      () => new RegexSet([{ pattern: 42, name: "x" }]),
    ).toThrow(/must be a string or RegExp/);
    expect(
      () => new RegexSet([{ pattern: null, name: "x" }]),
    ).toThrow(/must be a string or RegExp/);
  });

  test("invalid name type in NamedPattern throws", () => {
    expect(
      () => new RegexSet([{ pattern: "a", name: 42 }]),
    ).toThrow(/must be a string/);
    expect(
      () => new RegexSet([{ pattern: "a", name: ["x"] }]),
    ).toThrow(/must be a string/);
  });
});

// ─── DFA explosion: internal \b + alternations ─

describe("internal \\b DFA explosion", () => {
  // Regression: combining a large alternation pattern
  // with a pattern that has internal \b (not at edges)
  // caused DFA state explosion: 0.3ms → 73ms.
  //
  // Root cause: edge \b is stripped by strip-and-verify,
  // but internal \b (e.g. `(?:\bM\.|Mrs|...)`) stays
  // in the DFA with Unicode mode, causing combinatorial
  // state explosion with large alternation patterns.

  const TITLES = [
    "Ing\\.",
    "Mgr\\.",
    "JUDr\\.",
    "MUDr\\.",
    "PhDr\\.",
    "RNDr\\.",
    "Bc\\.",
    "BcA\\.",
    "ICDr\\.",
    "PaedDr\\.",
    "PhMr\\.",
    "ThDr\\.",
    "RSDr\\.",
    "ThLic\\.",
    "ThMgr\\.",
    "Dr\\.\\s*med\\.",
    "Dr\\.\\s*phil\\.",
    "Dr\\.\\s*rer\\.\\s*nat\\.",
    "Dr\\.\\s*rer\\.\\s*pol\\.",
    "Dr\\.\\s*jur\\.",
    "Dr\\.\\s*oec\\.",
    "Dr\\.\\s*Ing\\.",
    "Dr\\.\\s*techn\\.",
    "Dr\\.\\s*med\\.\\s*dent\\.",
    "Dr\\.\\s*med\\.\\s*vet\\.",
    "Dr\\.\\s*theol\\.",
    "Dr\\.\\s*habil\\.",
    "Dipl\\.-Ing\\.",
    "Dipl\\.-Kfm\\.",
    "Dipl\\.-Betriebsw\\.",
    "Dipl\\.-Wirt\\.-Ing\\.",
    "Mag\\.\\s*rer\\.\\s*nat\\.",
    "Mag\\.\\s*rer\\.\\s*soc\\.\\s*oec\\.",
    "Mag\\.\\s*phil\\.",
    "Mag\\.\\s*iur\\.",
    "Mag\\.\\s*theol\\.",
    "Bakk\\.\\s*rer\\.\\s*nat\\.",
    "ao\\.\\s*Univ\\.-Prof\\.",
    "o\\.\\s*Univ\\.-Prof\\.",
    "Priv\\.-Doz\\.",
    "PD",
    "RA",
    "Prof\\.",
    "doc\\.",
    "as\\.\\s*prof\\.",
    "Lic\\.\\s*iur\\.",
    "Lic\\.\\s*oec\\.",
    "Lic\\.\\s*phil\\.",
    "Lic\\.\\s*theol\\.",
    ...Array.from(
      { length: 32 },
      (_, i) => `Extra\\.\\s*Title${i}`,
    ),
  ];
  const titleAlt = TITLES.join("|");
  const bigAltPat =
    `(?:${titleAlt})` +
    `(?:\\s+(?:${titleAlt}))*` +
    `\\s+[A-Z][a-z]+` +
    `(?:\\s+[A-Z][a-z]+){0,2}`;
  const ibanPat =
    "\\b[A-Z]{2}\\d{2}\\s?" +
    "[\\dA-Z]{4}\\s?[\\dA-Z]{4}" +
    "\\s?[\\dA-Z]{4}\\s?[\\dA-Z]{4}" +
    "\\s?[\\dA-Z]{0,14}\\b";
  const internalBPat =
    "(?:\\bM\\.|Mrs|Ms|Mr)" + "\\.?\\s+[A-Z][a-z]+";

  test("correctness: internal \\b pattern matches", () => {
    const rs = new RegexSet([
      bigAltPat,
      internalBPat,
      ibanPat,
    ]);
    const matches = rs.findIter(
      "Ing. Smith and M. Jones here",
    );
    const texts = matches.map((m) => m.text);
    expect(texts).toContain("Ing. Smith");
    expect(texts).toContain("M. Jones");
  });

  test("correctness: internal \\b prevents false positive", () => {
    const rs = new RegexSet([
      bigAltPat,
      internalBPat,
      ibanPat,
    ]);
    // IBM. Smith should NOT match — \bM requires word
    // boundary before M, but B is a word character.
    const matches = rs.findIter("IBM. Smith here");
    const texts = matches.map((m) => m.text);
    expect(texts).not.toContain("M. Smith");
  });

  test("perf: no DFA explosion with internal \\b", () => {
    const rs = new RegexSet([
      bigAltPat,
      internalBPat,
      ibanPat,
    ]);

    // Warm up
    rs.findIter("test");

    // Mixed-content text with varied byte classes
    // triggers cache misses in an exploded DFA.
    const words = [
      "Společnost",
      "zastoupená",
      "jednatelem",
      "se sídlem",
      "IČO",
      "zapsaná",
      "v obchodním",
      "rejstříku",
      "vedeném",
      "Krajským",
      "soudem",
    ];
    const text = Array.from(
      { length: 5000 },
      (_, i) => words[i % words.length],
    ).join(" ");

    const runs: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t = performance.now();
      rs.findIter(text);
      runs.push(performance.now() - t);
    }
    runs.sort((a, b) => a - b);
    const median = runs[5]!;

    // Without fix: ~30ms on mixed Czech text.
    // With fix: <5ms.
    // Use 20ms threshold to avoid CI flakes.
    expect(median).toBeLessThan(20);
  });
});

// ─── Greedy \s* + lookahead across newline ────
// Regression: when \s* greedily consumes a newline
// and the trailing lookahead then rejects, the DFA
// discards the valid shorter match instead of
// backtracking. Manifests with legal form patterns
// like `a\.\s*s\.\s*(?![lower])` followed by a line
// starting with a lowercase letter.

describe("greedy quantifier + lookahead across newline", () => {
  test("\\s* does not discard valid match when lookahead rejects on next line", () => {
    // Pattern: match "Vinci a.s." with optional
    // trailing whitespace, but reject if followed
    // by a lowercase letter.
    const rs = new RegexSet([
      String.raw`[A-Z][a-z]+\s+a\.[\s]*s\.[\s]*(?![a-z])`,
    ]);

    // All should match "Vinci a.s."
    expect(rs.isMatch("Vinci a.s.\n")).toBe(true);
    expect(rs.isMatch("Vinci a.s.\nsídlo")).toBe(true);
    expect(rs.isMatch("Vinci a.s.\ns")).toBe(true);
    expect(rs.isMatch("Vinci a.s.\nxyz")).toBe(true);
    expect(rs.isMatch("Vinci a.s.")).toBe(true);
  });

  test("findIter returns correct match text with greedy \\s* + lookahead", () => {
    const rs = new RegexSet([
      String.raw`[A-Z][a-z]+\s+a\.[\s]*s\.[\s]*(?![a-z])`,
    ]);

    const m1 = rs.findIter("Vinci a.s.\nsídlo");
    expect(m1).toHaveLength(1);
    expect(m1[0]!.text).toBe("Vinci a.s.");

    const m2 = rs.findIter("Vinci a.s.\nse sídlem");
    expect(m2).toHaveLength(1);
    expect(m2[0]!.text).toBe("Vinci a.s.");
  });

  test("full legal form pattern with \\s* across newline", () => {
    // Simulate the actual legal form detection pattern
    const UPPER =
      "A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽÄÖÜÀÂÆÇÈÊËÎÏÔÙÛŸÑ\\u0130";
    const LOWER =
      "a-záčďéěíňóřšťúůýžäöüßàâæçèêëîïôùûÿñ\\u0131";
    const CAP = `(?:[${UPPER}]{2,}|[${UPPER}][${LOWER}${UPPER}]+)`;
    const ANY = `(?:[${UPPER}${LOWER}][${LOWER}${UPPER}]+|[${UPPER}]{2,3})`;
    const CONN = `(?:[\\s&,.-]{1,4}|\\s+(?:a|and|und|et|e|y|i)\\s+)`;
    const prefix = `(?:${CAP})(?:${CONN}(?:${ANY})){0,7}`;
    const alt = "a\\.\\s*s\\.\\s*";
    const pat = `${prefix}\\s+(?:${alt})(?![${LOWER}])`;

    const rs = new RegexSet([pat]);

    expect(rs.isMatch("VINCI Construction CS a.s.\nsídlo")).toBe(true);
    expect(rs.isMatch("VINCI Construction CS a.s.\nse sídlem")).toBe(true);
    expect(rs.isMatch("VINCI Construction CS a.s.\n")).toBe(true);
    expect(rs.isMatch("VINCI Construction CS a.s.")).toBe(true);
  });
});

// ─── Same Match type as aho-corasick ──────────

describe("Match type compatibility", () => {
  test("has pattern, start, end, text fields", () => {
    const rs = new RegexSet(["\\d+"]);
    const matches = rs.findIter("abc 123 def");
    const m = matches[0]!;

    expect(typeof m.pattern).toBe("number");
    expect(typeof m.start).toBe("number");
    expect(typeof m.end).toBe("number");
    expect(typeof m.text).toBe("string");
    expect(m.text).toBe(
      "abc 123 def".slice(m.start, m.end),
    );
  });
});
