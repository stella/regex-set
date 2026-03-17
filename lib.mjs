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

/**
 * Replace unescaped `\b` and `\B` with their
 * ASCII-only equivalents `(?-u:\b)` / `(?-u:\B)`.
 * Skips character classes `[...]` (where `\b` means
 * backspace) and escaped backslashes `\\b`.
 */
function asciiBoundaries(src) {
  let result = "";
  let inClass = false;
  let i = 0;
  while (i < src.length) {
    if (src[i] === "\\" && i + 1 < src.length) {
      const next = src[i + 1];
      if (
        !inClass &&
        (next === "b" || next === "B")
      ) {
        result += `(?-u:\\${next})`;
        i += 2;
      } else {
        // escaped char (including \\) — emit as-is
        result += src[i] + src[i + 1];
        i += 2;
      }
    } else {
      if (src[i] === "[") inClass = true;
      if (src[i] === "]") inClass = false;
      result += src[i];
      i++;
    }
  }
  return result;
}

/**
 * Convert a pattern (string or RegExp) to a Rust
 * regex string. Extracts .source from RegExp and
 * converts JS flags to Rust inline flags.
 *
 * Replaces `\b`/`\B` with `(?-u:\b)`/`(?-u:\B)`
 * so Rust uses ASCII-only word boundaries (matching
 * JS semantics) instead of expensive Unicode ones.
 */
function toRustPattern(p) {
  if (typeof p === "string")
    return asciiBoundaries(p);
  if (p instanceof RegExp) {
    let prefix = "";
    if (p.flags.includes("i")) prefix += "i";
    if (p.flags.includes("m")) prefix += "m";
    if (p.flags.includes("s")) prefix += "s";
    const src = asciiBoundaries(p.source);
    return prefix ? `(?${prefix})${src}` : src;
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
