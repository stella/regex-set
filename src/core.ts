/* Shared core: types, helpers, and RegexSet class
 * using a late-bound native backend (NAPI-RS or
 * WASM). Call initBinding() before constructing. */

// ── Native binding types ─────────────────────────

export type NativeBinding = {
  RegexSet: new (
    patterns: string[],
    options?: Record<string, unknown>,
  ) => NativeRegexSet;
};

type NativeRegexSet = {
  patternCount: number;
  _isMatchBuf(haystack: Buffer): boolean;
  _findIterPackedBuf(haystack: Buffer): Uint32Array;
  whichMatch(haystack: string): number[];
  replaceAll(
    haystack: string,
    replacements: string[],
  ): string;
};

// ── Late-bound native binding ────────────────────

let binding: NativeBinding;

/** Set the native backend. Must be called once
 *  before any class constructor. */
export const initBinding = (b: NativeBinding) => {
  binding = b;
};

// ── Public types ─────────────────────────────────

/** Options for constructing a RegexSet. */
export type Options = {
  /**
   * Only match whole words. Wraps each pattern
   * with `\b...\b`.
   * @default false
   */
  wholeWords?: boolean;
  /**
   * Use Unicode word boundaries. When `true`,
   * `\b` treats accented letters, CJK, etc. as
   * word characters (correct for non-English text).
   * When `false` (default), `\b` uses ASCII
   * semantics matching JS `RegExp` behavior.
   *
   * Zero performance overhead in either mode;
   * boundaries are verified inline per match.
   * Automatically uses UAX#29 segmentation for
   * Thai/CJK/Lao/Khmer/Myanmar text.
   * @default true
   */
  unicodeBoundaries?: boolean;
  /**
   * Case-insensitive matching. Wraps each pattern
   * with `(?i-u:...)` for ASCII case folding.
   * Uses `-u` to prevent DFA state explosion from
   * Unicode case tables.
   *
   * Edge `\b`/`\B` boundaries and leading bare-flag
   * prefixes (e.g. `(?m)`, `(?m-s)`) are extracted
   * before wrapping so they remain outside the `-u`
   * scope, preserving `unicodeBoundaries` semantics.
   * Patterns already containing any `(?{flags}-u`
   * group (from RegExp `/i`, inline `(?i)`, or
   * `scopeInlineFlags`) are not double-wrapped.
   * @default false
   */
  caseInsensitive?: boolean;
};

/** A named pattern entry. */
export type NamedPattern = {
  /** The regex pattern (string or RegExp). */
  pattern: string | RegExp;
  /** Optional name for this pattern. */
  name?: string;
};

/** A pattern entry: string, RegExp, or named. */
export type PatternEntry = string | RegExp | NamedPattern;

/** A single match result. */
export type Match = {
  /** Index of the pattern that matched. */
  pattern: number;
  /** Start UTF-16 code unit offset. */
  start: number;
  /** End offset (exclusive). */
  end: number;
  /** The matched text. */
  text: string;
  /** Pattern name (if provided at construction). */
  name?: string;
};

// ── Internal helpers ─────────────────────────────

type NormalizedEntry = {
  pattern: string;
  name: string | undefined;
};

function unpack(
  packed: Uint32Array,
  haystack: string,
  names: (string | undefined)[] | null,
): Match[] {
  const len = packed.length;
  // eslint-disable-next-line unicorn/no-new-array
  const matches: Match[] = new Array(len / 3);
  // SAFETY: Loop increments by 3 and terminates at packed.length.
  // Indices i, i+1, i+2 are always in bounds.
  for (let i = 0, j = 0; i < len; i += 3, j++) {
    const idx = packed[i]!;
    const s = packed[i + 1]!;
    const e = packed[i + 2]!;
    const m: Match = {
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
function asciiBoundaries(src: string): string {
  let result = "";
  let inClass = false;
  let i = 0;
  while (i < src.length) {
    if (src.charAt(i) === "\\" && i + 1 < src.length) {
      const next = src.charAt(i + 1);
      if (
        !inClass &&
        (next === "b" || next === "B")
      ) {
        result += `(?-u:\\${next})`;
        i += 2;
      } else {
        // escaped char (including \\) — emit as-is
        result += src.charAt(i) + src.charAt(i + 1);
        i += 2;
      }
    } else {
      if (src.charAt(i) === "[") inClass = true;
      if (src.charAt(i) === "]") inClass = false;
      result += src.charAt(i);
      i++;
    }
  }
  return result;
}

/**
 * Convert a RegExp to Rust regex syntax string.
 */
function regexpToRust(re: RegExp): string {
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
    const last = src.charAt(src.length - 1);
    if (last === "b" || last === "B") {
      let bs = 0;
      let k = src.length - 2;
      while (k >= 0 && src.charAt(k) === "\\") {
        bs++;
        k--;
      }
      if (bs > 0 && bs % 2 === 1) {
        trailing = "\\" + last;
        src = src.slice(0, -2);
      }
    }
  }

  const uFlag =
    needsAsciiMode(src) && !hasNonAscii(src)
      ? "-u"
      : "";
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
function needsAsciiMode(s: string): boolean {
  return /\\[wWdDsSbB]/.test(s);
}

/**
 * Check if a string contains non-ASCII characters.
 * When true, -u MUST NOT be added: regex-automata
 * rejects (?-u) alongside non-ASCII content like
 * [ÁČĎÉĚ] or literal złotych.
 */
function hasNonAscii(s: string): boolean {
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
function scopeInlineFlags(src: string): string {
  // Handle bare (?i...) at the start: convert to
  // scoped (?i-u:...) with edge \b/\B outside.
  const leadingBare = src.match(
    /^\(\?([ims]+)(?:-([imsu]+))?\)/,
  );
  if (leadingBare && leadingBare[1]!.includes("i")) {
    // SAFETY: The regex requires group 1 to match.
    const enable = leadingBare[1]!;
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
      const last = rest.charAt(rest.length - 1);
      if (last === "b" || last === "B") {
        let bs = 0;
        let k = rest.length - 2;
        while (k >= 0 && rest.charAt(k) === "\\") {
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
    const addU =
      needsAsciiMode(rest) &&
      !hasNonAscii(rest) &&
      !disable.includes("u");
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
function scopeInnerFlags(src: string): string {
  let result = "";
  let inClass = false;
  let i = 0;
  while (i < src.length) {
    if (src.charAt(i) === "\\" && i + 1 < src.length) {
      result += src.charAt(i) + src.charAt(i + 1);
      i += 2;
      continue;
    }
    if (src.charAt(i) === "[") inClass = true;
    if (src.charAt(i) === "]") inClass = false;
    if (
      !inClass &&
      src.charAt(i) === "(" &&
      src.charAt(i + 1) === "?"
    ) {
      let j = i + 2;
      let enable = "";
      while (
        j < src.length &&
        "ims".includes(src.charAt(j))
      ) {
        enable += src.charAt(j);
        j++;
      }
      // Handle disable part: (?i-s) or (?i-s:...)
      let disable = "";
      if (j < src.length && src.charAt(j) === "-") {
        j++; // skip -
        while (
          j < src.length &&
          "imsu".includes(src.charAt(j))
        ) {
          disable += src.charAt(j);
          j++;
        }
      }
      if (
        enable.length > 0 &&
        (src.charAt(j) === ")" || src.charAt(j) === ":")
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
            result += `(?${enable}-${disable}${src.charAt(j)}`;
          } else {
            result += `(?${enable}${src.charAt(j)}`;
          }
        } else if (disable.length > 0) {
          result += `(?${enable}-${disable}${src.charAt(j)}`;
        } else {
          result += `(?${enable}${src.charAt(j)}`;
        }
        i = j + 1;
        continue;
      }
    }
    result += src.charAt(i);
    i++;
  }
  return result;
}

/**
 * Normalize a pattern entry to { pattern, name }.
 */
function normalizeEntry(
  p: PatternEntry,
  i: number,
): NormalizedEntry {
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

// ── RegexSet class ───────────────────────────────

/**
 * Multi-pattern regex matcher.
 *
 * Compiles multiple regex patterns into a single
 * automaton. Guaranteed O(m * n) — no catastrophic
 * backtracking. Uses Rust regex syntax for string
 * patterns (no lookaheads/backreferences).
 *
 * @example
 * ```ts
 * // Simple
 * new RegexSet([/\d{8}/, "\\+?\\d{9,12}"]);
 *
 * // Named
 * new RegexSet([
 *   { pattern: /\d{8}/, name: "ico" },
 *   { pattern: /\d{2}\.\d{2}\.\d{4}/, name: "date" },
 * ]);
 * // match.name === "date"
 * ```
 */
export class RegexSet {
  private _inner: NativeRegexSet;
  private _names: (string | undefined)[];
  private _hasNames: boolean;

  constructor(
    patterns: PatternEntry[],
    options?: Options,
  ) {
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
        if (
          /^(?:\\[bB]|\(\?[ims]+(?:-[imsu]+)?\))*\(\?[ims]*i[ims]*(?:-[imsu]+)?[:(]/.test(
            p,
          )
        )
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
          const last = src.charAt(src.length - 1);
          if (last === "b" || last === "B") {
            let bs = 0;
            let k = src.length - 2;
            while (k >= 0 && src.charAt(k) === "\\") {
              bs++;
              k--;
            }
            if (bs > 0 && bs % 2 === 1) {
              trailing = "\\" + last;
              src = src.slice(0, -2);
            }
          }
        }
        const uFlag =
          needsAsciiMode(src) && !hasNonAscii(src)
            ? "-u"
            : "";
        return `${flagPrefix}${leading}(?i${uFlag}:${src})${trailing}`;
      });
    }

    if (!unicode) {
      processed = processed.map(asciiBoundaries);
    }

    // Strip JS-only options before passing to native
    const nativeOpts: Record<string, unknown> | undefined =
      options ? { ...options } : undefined;
    if (nativeOpts) {
      delete nativeOpts.caseInsensitive;
    }

    this._inner = new binding.RegexSet(
      processed,
      nativeOpts,
    );
  }

  /** Number of patterns. */
  get patternCount(): number {
    return this._inner.patternCount;
  }

  /** Returns `true` if any pattern matches. */
  isMatch(haystack: string): boolean {
    return this._inner._isMatchBuf(
      Buffer.from(haystack),
    );
  }

  /** Find all non-overlapping matches. */
  findIter(haystack: string): Match[] {
    return unpack(
      this._inner._findIterPackedBuf(
        Buffer.from(haystack),
      ),
      haystack,
      this._hasNames ? this._names : null,
    );
  }

  /** Which pattern indices matched (not where). */
  whichMatch(haystack: string): number[] {
    return this._inner.whichMatch(haystack);
  }

  /**
   * Replace all non-overlapping matches.
   * `replacements[i]` replaces pattern `i`.
   */
  replaceAll(
    haystack: string,
    replacements: string[],
  ): string {
    return this._inner.replaceAll(
      haystack,
      replacements,
    );
  }
}
