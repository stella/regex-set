import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  RegexSet,
  init,
  initSync,
} from "../../wasm/dist/single-thread.mjs";

// Node provides the WASI API used by the existing threaded NAPI loader.
const require = createRequire(import.meta.url);
const threaded = require("../../regex-set.wasi.cjs");
class ThreadedSet extends RegexSet {
  static getBinding() {
    return threaded;
  }
}
const bytes = readFileSync(
  new URL(
    "../../regex-set.single-thread.wasm",
    import.meta.url,
  ),
);
initSync(bytes);
try {
  for (const { text, replacement, expected } of [
    {
      text: "\uFEFFfoo",
      replacement: "x",
      expected: "\uFEFFx",
    },
    {
      text: "foo",
      replacement: "\uFEFFx",
      expected: "\uFEFFx",
    },
    {
      text: "\uFEFFabsent",
      replacement: "x",
      expected: "\uFEFFabsent",
    },
  ]) {
    const single = new RegexSet(["foo"]);
    const original = new ThreadedSet(["foo"]);
    assert.equal(
      original.replaceAll(text, [replacement]),
      expected,
    );
    assert.equal(
      single.replaceAll(text, [replacement]),
      expected,
    );
  }
  const corpus = [
    {
      patterns: ["foo", "foobar", "bar", "foo"],
      text: "foobar foo",
    },
    { patterns: [/hello/iu, /\d+/u], text: "HELLO 123" },
    { patterns: ["😀", "é", "中", "İ"], text: "😀é中 İ i" },
    {
      patterns: [{ pattern: "foo", name: "named" }],
      text: "foo",
    },
    { patterns: ["(?<!a)b", "a+"], text: "aaab b" },
    { patterns: ["\ud800"], text: "a\ud800b" },
    { patterns: [], text: "anything" },
    { patterns: ["absent"], text: "" },
  ];
  for (const caseInsensitive of [false, true]) {
    for (const wholeWords of [false, true]) {
      for (const unicodeBoundaries of [false, true]) {
        const options = {
          caseInsensitive,
          wholeWords,
          unicodeBoundaries,
        };
        for (const { patterns, text } of corpus) {
          const single = new RegexSet(patterns, options);
          const original = new ThreadedSet(
            patterns,
            options,
          );
          assert.equal(
            single.patternCount,
            original.patternCount,
          );
          assert.equal(
            single.isMatch(text),
            original.isMatch(text),
          );
          assert.deepEqual(
            single.findIter(text),
            original.findIter(text),
          );
          assert.deepEqual(
            single.whichMatch(text),
            original.whichMatch(text),
          );
          const replacements = patterns.map(
            (_, index) => `[${index}]`,
          );
          assert.equal(
            single.replaceAll(text, replacements),
            original.replaceAll(text, replacements),
          );
          const prepared = ThreadedSet.prepare(
            patterns,
            options,
          );
          assert.deepEqual(
            new RegexSet(
              patterns,
              options,
              prepared,
            ).findIter(text),
            original.findIter(text),
          );
          const singlePrepared = RegexSet.prepare(
            patterns,
            options,
          );
          assert.deepEqual(
            new ThreadedSet(
              patterns,
              options,
              singlePrepared,
            ).findIter(text),
            single.findIter(text),
          );
        }
      }
    }
  }
  await init(bytes);
  assert.equal(
    new ThreadedSet(["old"]).isMatch("old"),
    true,
  );
  assert.equal(new RegexSet(["new"]).isMatch("new"), true);
} finally {
  const dispose = Reflect.get(
    threaded,
    Symbol.for("napi.rs.wasi.dispose"),
  );
  if (typeof dispose === "function") await dispose();
}
