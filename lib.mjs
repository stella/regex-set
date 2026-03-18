// @ts-nocheck
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const native = require("./index.js");

const NativeRegexSet = native.RegexSet;

function unpack(packed, haystack, names) {
  const len = packed.length;
  // eslint-disable-next-line unicorn/no-new-array
  const matches = new Array(len / 3);
  for (let i = 0, j = 0; i < len; i += 3, j++) {
    const idx = packed[i];
    const s = packed[i + 1];
    const e = packed[i + 2];
    const m = {
      pattern: idx,
      start: s,
      end: e,
      text: haystack.slice(s, e),
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
 * Convert a RegExp to Rust regex syntax string.
 */
function regexpToRust(re) {
  let flags = "";
  if (re.flags.includes("i")) flags += "i";
  if (re.flags.includes("m")) flags += "m";
  if (re.flags.includes("s")) flags += "s";

  if (!flags) return re.source;

  if (!flags.includes("i")) {
    return `(?${flags})${re.source}`;
  }

  let src = re.source;
  let leading = "";
  let trailing = "";

  if (src.startsWith("\\b")) {
    leading = "\\b";
    src = src.slice(2);
  } else if (src.startsWith("\\B")) {
    leading = "\\B";
    src = src.slice(2);
  }
  if (
    src.endsWith("\\b") &&
    !src.endsWith("\\\\b")
  ) {
    trailing = "\\b";
    src = src.slice(0, -2);
  } else if (
    src.endsWith("\\B") &&
    !src.endsWith("\\\\B")
  ) {
    trailing = "\\B";
    src = src.slice(0, -2);
  }

  return `${leading}(?${flags}-u:${src})${trailing}`;
}

/**
 * Normalize a pattern entry to { pattern, name }.
 */
function normalizeEntry(p, i) {
  if (typeof p === "string") {
    return { pattern: p, name: undefined };
  }
  if (p instanceof RegExp) {
    return {
      pattern: regexpToRust(p),
      name: undefined,
    };
  }
  if (
    typeof p === "object" &&
    p !== null &&
    "pattern" in p
  ) {
    if (
      typeof p.pattern !== "string" &&
      !(p.pattern instanceof RegExp)
    ) {
      throw new TypeError(
        `Pattern at index ${i}: "pattern" ` +
          "field must be a string or RegExp",
      );
    }
    const inner =
      p.pattern instanceof RegExp
        ? { pattern: regexpToRust(p.pattern) }
        : { pattern: p.pattern };
    if (
      p.name !== undefined &&
      typeof p.name !== "string"
    ) {
      throw new TypeError(
        `Pattern at index ${i}: "name" ` +
          "field must be a string",
      );
    }
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

    const unicode =
      options?.unicodeBoundaries ?? true;
    const processed = unicode
      ? entries.map((e) => e.pattern)
      : entries.map((e) =>
          asciiBoundaries(e.pattern),
        );

    this._inner = new NativeRegexSet(
      processed,
      options,
    );
  }

  get patternCount() {
    return this._inner.patternCount;
  }

  isMatch(haystack) {
    return this._inner._isMatchBuf(
      Buffer.from(haystack),
    );
  }

  findIter(haystack) {
    return unpack(
      this._inner._findIterPackedBuf(
        Buffer.from(haystack),
      ),
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

export { RegexSet };
