import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("single-thread entry imports without initialization side effects", async () => {
  const entry = await import("../src/single-thread");
  expect(entry.init).toBeFunction();
  expect(entry.initSync).toBeFunction();
  expect(entry.RegexSet).toBeFunction();
});

test("single-thread runtime searches and preserves a leading BOM", async () => {
  const entry = await import("../src/single-thread");
  entry.initSync(readFileSync("regex-set.single-thread.wasm"));
  const set = new entry.RegexSet(["x"]);
  expect(set.isMatch("x")).toBe(true);
  expect(set.replaceAll("\uFEFFx", ["y"])).toBe("\uFEFFy");
});
