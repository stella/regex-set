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
    expect(
      set.isMatch(haystack),
      `${pattern} on ${JSON.stringify(haystack)}`,
    ).toBe(pattern.test(haystack));
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
      for (const flags of ["", "i", "u", "iu"]) {
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

  test("ASCII ignore-case literals retain JavaScript folding without shortcuts", () => {
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz") {
      for (const source of [
        letter,
        `[${letter}]`,
        `[^${letter}]`,
        `${letter}.[^a]`,
        `\\x${letter.charCodeAt(0).toString(16)}`,
      ]) {
        for (const flags of ["i", "iu"]) {
          const pattern = new RegExp(`^(?:${source})$`, flags);
          for (const text of [
            letter,
            letter.toUpperCase(),
            letter.toLowerCase(),
            `${letter}xb`,
            `${letter.toUpperCase()}xb`,
            `${letter}xa`,
            "\u017fxb",
            "\u212axb",
            "éxb",
            "😀xb",
            "\u017f",
            "\u212a",
          ]) {
            assertOracle(pattern, text);
          }
        }
      }
    }
  });

  test("dots and complemented classes remain Unicode-safe in legacy ignore-case patterns", () => {
    for (const pattern of [
      /./i,
      /.+/i,
      /[^a]/i,
      /k.[^a]/i,
      /\w.[^a]/i,
      /(?<word>k).[^a]/i,
      /\x6b.[^a]/i,
      /\u006b.[^a]/i,
      /[é\s].[^a]/i,
      /[\u00e9\s].[^a]/i,
    ]) {
      for (const text of [
        "",
        "a",
        "A",
        "kxb",
        "Kxb",
        "\u212axb",
        "é",
        "Éxb",
        "😀",
        "k😀b",
        "ſxb",
      ]) {
        assertOracle(pattern, text);
      }
    }
  });

  test("non-Unicode whitespace classes retain ASCII word and literal folding", () => {
    for (const source of [
      "\\s",
      "\\S",
      "[\\s]",
      "[\\S]",
      "[^\\s]",
      "[^\\S]",
      "[a-z\\s]",
      "[^a-z\\s]",
      "[a-\\s]",
      "[\\s-z]",
      "[k\\s\\w]",
      "[^k\\s\\w]",
      "[\\s\\W]",
      "[^\\s\\W]",
      "[\\s\\d]",
      "[\\s\\D]",
      "[\\\\s\\s]",
      "[^\\\\s\\s]",
      "[\\]\\s]",
      "[é\\s]",
      "[\\b\\s]",
      "[\\B\\s]",
      "[\\x73\\s]",
      "k\\s",
      "\\\\s",
      "[\\\\s]",
    ]) {
      const pattern = new RegExp(`^(?:${source})$`, "i");
      for (const text of [
        " ",
        "\t",
        "\n",
        "\u00a0",
        "\ufeff",
        "\u0085",
        "\u200b",
        "a",
        "A",
        "k",
        "K",
        "s",
        "S",
        "\u212a",
        "\u017f",
        "é",
        "É",
        "1",
        "_",
        "\\",
        "]",
        "k\ufeff",
        "K\ufeff",
        "\u212a\ufeff",
        "\\s",
        "\b",
        "b",
        "B",
      ]) {
        assertOracle(pattern, text);
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

  test("generated non-Unicode whitespace patterns match their JavaScript witnesses", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom(
            { source: "\\s", witness: "\ufeff" },
            { source: "\\S", witness: "k" },
            { source: "[a-z\\s]", witness: "K" },
            { source: "[^a-z\\s]", witness: "\u212a" },
            { source: "[\\s\\w]", witness: "S" },
            { source: "[^k\\s\\w]", witness: "\u017f" },
            { source: "[\\s\\W]", witness: "\u212a" },
            { source: "[\\\\s\\s]", witness: "s" },
            { source: "\\\\s", witness: "\\s" },
          ),
          { minLength: 1, maxLength: 4 },
        ),
        fc.constantFrom("i", "im", "is"),
        (entries, flags) => {
          const pattern = new RegExp(
            entries.map(({ source }) => source).join(""),
            flags,
          );
          const witness = entries
            .map(({ witness: entryWitness }) => entryWitness)
            .join("");
          expect(pattern.test(witness)).toBe(true);
          assertOracle(pattern, witness);
        },
      ),
      { numRuns: 200 },
    );
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
