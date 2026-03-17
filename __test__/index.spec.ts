import { describe, expect, test } from "bun:test";

import { RegexSet } from "../lib";

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
    const rs = new RegexSet([
      "\\d{2}\\.\\d{2}\\.\\d{4}",
    ]);
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
    const rs = new RegexSet([
      "foo",
      "bar",
      "baz",
    ]);
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
    expect(result).toBe(
      "Born [DATE], phone [PHONE]",
    );
  });

  test("replaceAll throws on wrong count", () => {
    const rs = new RegexSet(["a", "b"]);
    expect(() =>
      rs.replaceAll("ab", ["x"]),
    ).toThrow();
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
    expect(rs.findIter("abc 123 def").length).toBe(
      1,
    );
  });

  test("regex pattern with wholeWords", () => {
    const rs = new RegexSet(
      ["\\d{2}\\.\\d{2}\\.\\d{4}"],
      { wholeWords: true },
    );
    const matches = rs.findIter(
      "date 15.03.1990 ok",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toBe("15.03.1990");

    // Not a whole word if glued to text
    expect(
      rs.findIter("date15.03.1990ok").length,
    ).toBe(0);
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
