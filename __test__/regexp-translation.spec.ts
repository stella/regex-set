import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { RegexSet } from "../src/index";

const assertOracle = (
  pattern: RegExp,
  haystack: string,
) => {
  for (const options of [
    undefined,
    { unicodeBoundaries: false },
  ]) {
    const set = new RegexSet([pattern], options);
    expect(set.isMatch(haystack)).toBe(
      pattern.test(haystack),
    );
  }
};

describe("JavaScript RegExp character classes", () => {
  test("keeps JavaScript word boundaries independent of engine boundary options", () => {
    expect(/\bfoo/iu.test("éfoo")).toBe(true);
    expect(/\Bfoo/iu.test("éfoo")).toBe(false);
    for (const pattern of [
      /\bfoo/iu,
      /\Bfoo/iu,
      /foo\b/iu,
      /foo\B/iu,
      /f\boo/iu,
      /f\Boo/iu,
      /\b[sk]/iu,
      /\B[sk]/iu,
      /\\bfoo/iu,
      /[\b]foo/iu,
    ]) {
      for (const text of [
        "éfoo",
        "fooé",
        "foo",
        " foo ",
        "xfoo",
        "ſ",
        "K",
        "éſ",
        "éK",
        "\\bfoo",
        "\bfoo",
      ]) {
        assertOracle(pattern, text);
      }
    }
  });

  test("preserves whitespace and word classes after Unicode literals", () => {
    for (const separator of ["\u00a0", "\ufeff"]) {
      const text = `SUPREME${separator}COURT`;
      const pattern = /Supreme\sCourt/iu;
      expect(pattern.test(text)).toBe(true);
      assertOracle(pattern, text);
    }
    const pattern = /ž\w/iu;
    expect(pattern.test("žř")).toBe(false);
    assertOracle(pattern, "žř");
  });

  test("uses ECMAScript whitespace", () => {
    for (const separator of [
      " ",
      "\t",
      "\n",
      "\u00a0",
      "\ufeff",
      "\u0085",
      "\u200b",
    ]) {
      for (const flags of ["", "u", "iu"]) {
        assertOracle(
          new RegExp("Supreme\\sCourt", flags),
          `Supreme${separator}Court`,
        );
        assertOracle(
          new RegExp("Supreme[\\s]Court", flags),
          `Supreme${separator}Court`,
        );
        assertOracle(
          new RegExp("Supreme\\SCourt", flags),
          `Supreme${separator}Court`,
        );
      }
    }
  });

  test("preserves Unicode word case folding", () => {
    for (const token of [
      "\\w",
      "\\W",
      "[\\w]",
      "[^\\w]",
      "[\\W]",
    ]) {
      for (const char of [
        "K",
        "k",
        "\u212a",
        "S",
        "s",
        "\u017f",
        "é",
        "1",
        "_",
      ]) {
        assertOracle(new RegExp(`^${token}$`, "iu"), char);
      }
    }
  });

  test("retains non-Unicode case-insensitive word classes", () => {
    for (const token of ["\\w", "[\\w]", "[a-z\\w]"]) {
      for (const char of [
        "K",
        "k",
        "\u212a",
        "S",
        "s",
        "\u017f",
        "é",
        "1",
        "_",
      ]) {
        assertOracle(new RegExp(`^${token}$`, "i"), char);
      }
    }
  });

  test("keeps escaped backslashes outside Unicode flag changes", () => {
    const pattern = /(?<!\p{L})\\s(?:e?s)?(?!\p{L})/iu;
    for (const haystack of [
      "\\s",
      "\\ses",
      "x\\s",
      "\\sx",
      " s ",
    ]) {
      assertOracle(pattern, haystack);
    }
  });

  test("generated escaped shortcuts agree with JavaScript", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom(
            "\\s",
            "\\S",
            "\\w",
            "\\W",
            "\\d",
            "\\D",
            "\\b",
            "\\B",
            "\\\\b",
            "\\\\B",
            "[\\b]",
            "\\\\s",
            "\\\\w",
            "\\\\S",
            "\\\\W",
            "\\\\d",
            "[\\S]",
            "[\\W]",
            "[\\d]",
            "[^\\s]",
            "[\\s]",
            "[\\w]",
          ),
          { minLength: 1, maxLength: 4 },
        ),
        fc.array(
          fc.constantFrom(
            "s",
            "w",
            "\\",
            " ",
            "\u00a0",
            "\ufeff",
            "\u0085",
            "\u212a",
            "\u017f",
            "é",
            "foo",
            "éfoo",
            "fooé",
            "\b",
            "1",
            "_",
          ),
          { maxLength: 12 },
        ),
        (tokens, chars) =>
          assertOracle(
            new RegExp(tokens.join(""), "iu"),
            chars.join(""),
          ),
      ),
      { numRuns: 200 },
    );
  });
});
