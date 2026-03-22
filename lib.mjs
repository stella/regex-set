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

  // JS RegExp objects can't contain inline (?i) in
  // .source — it's a SyntaxError. No need to run
  // scopeInlineFlags here; it only matters for
  // string patterns (handled in normalizeEntry).
  if (!flags) {
    return re.source;
  }

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
  if (src.length >= 2) {
    const last = src[src.length - 1];
    if (last === "b" || last === "B") {
      let bs = 0;
      let k = src.length - 2;
      while (k >= 0 && src[k] === "\\") {
        bs++;
        k--;
      }
      if (bs > 0 && bs % 2 === 1) {
        trailing = "\\" + last;
        src = src.slice(0, -2);
      }
    }
  }

  const uFlag = needsAsciiMode(src) && !hasNonAscii(src)
    ? "-u" : "";
  return `${leading}(?${flags}${uFlag}:${src})${trailing}`;
}

/**
 * Check if content uses character class shortcuts
 * (\w, \W, \d, \D, \s, \S, \b, \B) that have
 * Unicode-aware versions. Only these benefit from
 * -u (ASCII-only mode). Literal strings like
 * "dollars" produce identical DFAs with or without
 * -u, so skipping -u for them is zero-cost.
 */
function needsAsciiMode(s) {
  return /\\[wWdDsSbB]/.test(s);
}

/**
 * Check if a string contains non-ASCII characters.
 * When true, -u MUST NOT be added: regex-automata
 * rejects (?-u) alongside non-ASCII content like
 * [ÁČĎÉĚ] or literal złotych.
 */
function hasNonAscii(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) return true;
  }
  return false;
}

/**
 * Convert inline (?i) flags to (?i-u) for ASCII
 * case folding. Handles bare and scoped groups.
 *
 * Bare (?i) at the start of a pattern is converted
 * to a scoped group (?i-u:...) with edge \b pulled
 * outside, matching the RegExp path behaviour. This
 * prevents -u from affecting \b word boundary
 * semantics (which should remain Unicode when
 * unicodeBoundaries is true).
 *
 * NOTE: -u also disables Unicode character classes
 * (\w, \d, \s become ASCII-only), matching the
 * behaviour of regexpToRust() for /i RegExps.
 */
function scopeInlineFlags(src) {
  // Handle bare (?i...) at the start: convert to
  // scoped (?i-u:...) with edge \b/\B outside.
  const leadingBare = src.match(
    /^\(\?([ims]+)(?:-([imsu]+))?\)/,
  );
  if (leadingBare && leadingBare[1].includes("i")) {
    const enable = leadingBare[1];
    const disable = leadingBare[2] || "";
    let rest = src.slice(leadingBare[0].length);

    // Strip edge \b/\B
    let leading = "";
    let trailing = "";
    if (rest.startsWith("\\b")) {
      leading = "\\b";
      rest = rest.slice(2);
    } else if (rest.startsWith("\\B")) {
      leading = "\\B";
      rest = rest.slice(2);
    }
    if (rest.length >= 2) {
      const last = rest[rest.length - 1];
      if (last === "b" || last === "B") {
        let bs = 0;
        let k = rest.length - 2;
        while (k >= 0 && rest[k] === "\\") {
          bs++;
          k--;
        }
        if (bs > 0 && bs % 2 === 1) {
          trailing = "\\" + last;
          rest = rest.slice(0, -2);
        }
      }
    }

    // Scope the flags and recurse for any nested
    // inline flags in the content.
    const inner = scopeInnerFlags(rest);
    // Only add -u when content uses char class
    // shortcuts (\w, \d, \s) that benefit from it.
    const addU = needsAsciiMode(rest)
      && !hasNonAscii(rest)
      && !disable.includes("u");
    const merged = addU ? disable + "u" : disable;
    const disablePart = merged ? `-${merged}` : "";
    return `${leading}(?${enable}${disablePart}:${inner})${trailing}`;
  }

  return scopeInnerFlags(src);
}

/**
 * Replace inline (?i) / (?i:...) groups with -u
 * variants. Does not handle leading bare flags
 * (that's done by scopeInlineFlags above).
 */
function scopeInnerFlags(src) {
  let result = "";
  let inClass = false;
  let i = 0;
  while (i < src.length) {
    if (src[i] === "\\" && i + 1 < src.length) {
      result += src[i] + src[i + 1];
      i += 2;
      continue;
    }
    if (src[i] === "[") inClass = true;
    if (src[i] === "]") inClass = false;
    if (
      !inClass &&
      src[i] === "(" &&
      src[i + 1] === "?"
    ) {
      let j = i + 2;
      let enable = "";
      while (
        j < src.length &&
        "ims".includes(src[j])
      ) {
        enable += src[j];
        j++;
      }
      // Handle disable part: (?i-s) or (?i-s:...)
      let disable = "";
      if (j < src.length && src[j] === "-") {
        j++; // skip -
        while (
          j < src.length &&
          "imsu".includes(src[j])
        ) {
          disable += src[j];
          j++;
        }
      }
      if (
        enable.length > 0 &&
        (src[j] === ")" || src[j] === ":")
      ) {
        if (enable.includes("i")) {
          // For scoped groups (?i:content), don't add
          // -u: literal strings produce identical DFAs
          // with or without -u, and -u breaks when
          // the overall pattern has non-ASCII chars.
          // For bare flags (?i), the -u would apply to
          // the rest of the pattern which might have
          // \w/\d — but bare flags are handled by
          // scopeInlineFlags, not here.
          if (disable.length > 0) {
            result += `(?${enable}-${disable}${src[j]}`;
          } else {
            result += `(?${enable}${src[j]}`;
          }
        } else if (disable.length > 0) {
          result += `(?${enable}-${disable}${src[j]}`;
        } else {
          result += `(?${enable}${src[j]}`;
        }
        i = j + 1;
        continue;
      }
    }
    result += src[i];
    i++;
  }
  return result;
}

/**
 * Normalize a pattern entry to { pattern, name }.
 */
function normalizeEntry(p, i) {
  if (typeof p === "string") {
    return {
      pattern: scopeInlineFlags(p),
      name: undefined,
    };
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
        : {
            pattern: scopeInlineFlags(p.pattern),
          };
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
    const ci = options?.caseInsensitive ?? false;

    let processed = entries.map((e) => e.pattern);

    // Wrap with (?i-u:...) for case-insensitive
    // matching. Edge \b/\B are extracted first so
    // they stay outside the -u scope (preserving
    // Unicode word boundary semantics).
    if (ci) {
      processed = processed.map((p) => {
        // Skip patterns already wrapped by
        // regexpToRust or scopeInlineFlags.
        if (/^(?:\\[bB]|\(\?[ims]+(?:-[imsu]+)?\))*\(\?[ims]*i[ims]*-[imsu]*u/.test(p))
          return p;
        // Strip leading bare-flag prefix (e.g. (?m),
        // (?ms)) before extracting edge \b.
        let src = p;
        let flagPrefix = "";
        const bareFlagMatch = src.match(
          /^\(\?[ims]+(?:-[imsu]+)?\)/,
        );
        if (bareFlagMatch) {
          flagPrefix = bareFlagMatch[0];
          src = src.slice(flagPrefix.length);
        }
        // Extract edge \b/\B
        let leading = "";
        let trailing = "";
        if (src.startsWith("\\b")) {
          leading = "\\b";
          src = src.slice(2);
        } else if (src.startsWith("\\B")) {
          leading = "\\B";
          src = src.slice(2);
        }
        if (src.length >= 2) {
          const last = src[src.length - 1];
          if (last === "b" || last === "B") {
            let bs = 0;
            let k = src.length - 2;
            while (k >= 0 && src[k] === "\\") {
              bs++;
              k--;
            }
            if (bs > 0 && bs % 2 === 1) {
              trailing = "\\" + last;
              src = src.slice(0, -2);
            }
          }
        }
        const uFlag = needsAsciiMode(src) && !hasNonAscii(src) ? "-u" : "";
        return `${flagPrefix}${leading}(?i${uFlag}:${src})${trailing}`;
      });
    }

    if (!unicode) {
      processed = processed.map(asciiBoundaries);
    }

    // Strip JS-only options before passing to native
    const nativeOpts = options
      ? { ...options }
      : undefined;
    if (nativeOpts) {
      delete nativeOpts.caseInsensitive;
    }

    this._inner = new NativeRegexSet(
      processed,
      nativeOpts,
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
