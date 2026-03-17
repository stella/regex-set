// @ts-nocheck
/* Wrapper that unpacks Uint32Array results from
 * the native module into Match objects. */

const native = require("./index.js");

const NativeRegexSet = native.RegexSet;

function unpack(packed, haystack, names) {
  const len = packed.length;
  // eslint-disable-next-line unicorn/no-new-array
  const matches = new Array(len / 3);
  for (let i = 0, j = 0; i < len; i += 3, j++) {
    const idx = packed[i];
    const start = packed[i + 1];
    const end = packed[i + 2];
    const m = {
      pattern: idx,
      start,
      end,
      text: haystack.slice(start, end),
    };
    if (names && names[idx] !== undefined)
      m.name = names[idx];
    matches[j] = m;
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
 * Normalize a pattern entry to { pattern, name }.
 * Applies asciiBoundaries to convert \b/\B to
 * ASCII-only equivalents matching JS semantics.
 */
function normalizeEntry(p, i) {
  if (typeof p === "string") {
    return {
      pattern: asciiBoundaries(p),
      name: undefined,
    };
  }
  if (p instanceof RegExp) {
    let prefix = "";
    if (p.flags.includes("i")) prefix += "i";
    if (p.flags.includes("m")) prefix += "m";
    if (p.flags.includes("s")) prefix += "s";
    const src = asciiBoundaries(p.source);
    return {
      pattern: prefix
        ? `(?${prefix})${src}`
        : src,
      name: undefined,
    };
  }
  if (
    typeof p === "object" &&
    p !== null &&
    "pattern" in p
  ) {
    const inner =
      p.pattern instanceof RegExp
        ? normalizeEntry(p.pattern, i)
        : {
            pattern: asciiBoundaries(p.pattern),
          };
    return {
      pattern: inner.pattern,
      name: p.name,
    };
  }
  throw new TypeError(
    `Pattern at index ${i} must be a string, ` +
      "RegExp, or { pattern, name }",
  );
}

class RegexSet {
  constructor(patterns, options) {
    const entries = patterns.map(normalizeEntry);
    this._names = entries.map((e) => e.name);
    this._hasNames = entries.some(
      (e) => e.name !== undefined,
    );
    this._inner = new NativeRegexSet(
      entries.map((e) => e.pattern),
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
      this._hasNames ? this._names : null,
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

module.exports.RegexSet = RegexSet;
