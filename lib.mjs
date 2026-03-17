// @ts-nocheck
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const native = require("./index.js");

const NativeRegexSet = native.RegexSet;

function unpack(packed, haystack) {
  const len = packed.length;
  // eslint-disable-next-line unicorn/no-new-array
  const matches = new Array(len / 3);
  for (let i = 0, j = 0; i < len; i += 3, j++) {
    const start = packed[i + 1];
    const end = packed[i + 2];
    matches[j] = {
      pattern: packed[i],
      start,
      end,
      text: haystack.slice(start, end),
    };
  }
  return matches;
}

function toRustPattern(p) {
  if (typeof p === "string") return p;
  if (p instanceof RegExp) {
    let prefix = "";
    if (p.flags.includes("i")) prefix += "i";
    if (p.flags.includes("m")) prefix += "m";
    if (p.flags.includes("s")) prefix += "s";
    return prefix
      ? `(?${prefix})${p.source}`
      : p.source;
  }
  throw new TypeError(
    "Pattern must be a string or RegExp",
  );
}

class RegexSet {
  constructor(patterns, options) {
    this._inner = new NativeRegexSet(
      patterns.map(toRustPattern),
      options,
    );
  }

  get patternCount() {
    return this._inner.patternCount;
  }

  isMatch(haystack) {
    return this._inner.isMatch(haystack);
  }

  findIter(haystack) {
    return unpack(
      this._inner._findIterPacked(haystack),
      haystack,
    );
  }

  whichMatch(haystack) {
    return this._inner.whichMatch(haystack);
  }

  replaceAll(haystack, replacements) {
    return this._inner.replaceAll(
      haystack,
      replacements,
    );
  }
}

export { RegexSet };
