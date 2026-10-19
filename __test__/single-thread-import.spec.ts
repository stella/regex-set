import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import nativeBinding from "../index.cjs";
import { initBinding } from "../src/core";
import { RegexSet as NativeRegexSet } from "../src/index";

test("single-thread entry imports without initialization side effects", async () => {
  const entry = await import("../src/single-thread");
  expect(entry.init).toBeFunction();
  expect(entry.initSync).toBeFunction();
  expect(entry.RegexSet).toBeFunction();
});

test("single-thread runtime searches and preserves a leading BOM", async () => {
  const entry = await import("../src/single-thread");
  entry.initSync(
    readFileSync("regex-set.single-thread.wasm"),
  );
  const set = new entry.RegexSet(["x"]);
  expect(set.isMatch("x")).toBe(true);
  expect(set.replaceAll("\uFEFFx", ["y"])).toBe("\uFEFFy");
});

test.each(["\uD800", "\uDC00"])(
  "single-thread matches native lone surrogate behavior for %s",
  async (surrogate) => {
    const pattern = `before${surrogate}after`;
    const haystack = `x${pattern}y`;
    initBinding(nativeBinding);
    const native = new NativeRegexSet([pattern]);
    const expected = {
      isMatch: native.isMatch(haystack),
      matches: native.findIter(haystack),
      which: native.whichMatch(haystack),
      replaced: native.replaceAll(haystack, ["match"]),
    };

    const entry = await import("../src/single-thread");
    entry.initSync(
      readFileSync("regex-set.single-thread.wasm"),
    );
    const singleThread = new entry.RegexSet([pattern]);
    expect(singleThread.isMatch(haystack)).toBe(
      expected.isMatch,
    );
    expect(singleThread.findIter(haystack)).toEqual(
      expected.matches,
    );
    expect(singleThread.whichMatch(haystack)).toEqual(
      expected.which,
    );
    expect(
      singleThread.replaceAll(haystack, ["match"]),
    ).toBe(expected.replaced);
  },
);
