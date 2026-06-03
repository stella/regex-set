/* Shared core: types, helpers, and the RegexSet
 * class that uses a late-bound native backend
 * (NAPI-RS or WASM).
 * Call initBinding() before constructing classes. */

const encoder = new TextEncoder();

// -- Native binding types --------------------------------

export type NativeBinding = {
  RegexSet: new (
    patterns: string[],
    options?: NativeOptions | null,
  ) => NativeRegexSetInstance;
  _uax29Boundaries: (
    haystack: Buffer | Uint8Array,
  ) => number[];
};

type NativeOptions = {
  wholeWords?: boolean;
  unicodeBoundaries?: boolean;
};

type NativeRegexSetInstance = {
  patternCount: number;
  isMatch(haystack: string): boolean;
  _isMatchBuf(haystack: Buffer | Uint8Array): boolean;
  _findIterPacked(haystack: string): Uint32Array;
  _findIterPackedBuf(
    haystack: Buffer | Uint8Array,
  ): Uint32Array;
  whichMatch(haystack: string): number[];
  replaceAll(
    haystack: string,
    replacements: string[],
  ): string;
};

type JsFallback = {
  pattern: number;
  re: RegExp;
};

type NativeSingle = {
  pattern: number;
  inner: NativeRegexSetInstance;
};

type BoundaryOptions = {
  wholeWords: boolean;
  unicodeBoundaries: boolean;
};

// -- Late-bound native binding ---------------------------

let binding: NativeBinding;

/** Set the native backend. Must be called once
 *  before any class constructor. */
export const initBinding = (b: NativeBinding) => {
  binding = b;
};

// -- Public types ----------------------------------------

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

// -- Unpack helper ---------------------------------------

function unpack(
  packed: Uint32Array,
  haystack: string,
  names: (string | undefined)[] | null,
  indexMap?: number[],
): Match[] {
  const len = packed.length;
  // eslint-disable-next-line unicorn/no-new-array
  const matches = new Array<Match>(len / 3);
  for (let i = 0, j = 0; i < len; i += 3, j++) {
    const idx = packed[i];
    const s = packed[i + 1];
    const e = packed[i + 2];
    if (
      idx === undefined ||
      s === undefined ||
      e === undefined
    ) {
      throw new Error(
        `Corrupt packed match data at offset ${i}`,
      );
    }
    const pattern = indexMap ? indexMap[idx] : idx;
    if (pattern === undefined) {
      throw new Error(`Missing native index map ${idx}`);
    }
    const m: Match = {
      pattern,
      start: s,
      end: e,
      text: haystack.slice(s, e),
    };
    if (names && names[pattern] !== undefined)
      m.name = names[pattern];
    matches[j] = m;
  }
  return matches;
}

// -- Regex flag helpers ----------------------------------

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
      if (!inClass && (next === "b" || next === "B")) {
        result += `(?-u:\\${next})`;
        i += 2;
      } else {
        // escaped char (including \\) -- emit as-is
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
  // .source -- it's a SyntaxError. No need to run
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
    const last = src.at(-1);
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

  const uFlag =
    needsAsciiMode(src) && !hasNonAscii(src) ? "-u" : "";
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
 * [ACDE] or literal zlotych.
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
  const enableGroup = leadingBare?.[1];
  if (leadingBare && enableGroup?.includes("i")) {
    const enable = enableGroup;
    const disable = leadingBare[2] ?? "";
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
      const last = rest.at(-1);
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
    if (src[i] === "\\" && i + 1 < src.length) {
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
          // \w/\d -- but bare flags are handled by
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

// -- Pattern normalization -------------------------------

type NormalizedEntry = {
  pattern: string;
  name: string | undefined;
};

/**
 * Normalize a pattern entry to { pattern, name }.
 */
function normalizeEntry(
  p: unknown,
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
    typeof p !== "object" ||
    p === null ||
    !("pattern" in p)
  ) {
    throw new TypeError(
      `Pattern at index ${i} must be a string, ` +
        "RegExp, or { pattern, name }",
    );
  }

  const pattern = p.pattern;
  if (
    typeof pattern !== "string" &&
    !(pattern instanceof RegExp)
  ) {
    throw new TypeError(
      `Pattern at index ${i}: "pattern" ` +
        "field must be a string or RegExp",
    );
  }

  const name = "name" in p ? p.name : undefined;
  if (name !== undefined && typeof name !== "string") {
    throw new TypeError(
      `Pattern at index ${i}: "name" ` +
        "field must be a string",
    );
  }

  return {
    pattern:
      pattern instanceof RegExp
        ? regexpToRust(pattern)
        : scopeInlineFlags(pattern),
    name,
  };
}

// -- RegexSet class --------------------------------------

/**
 * Multi-pattern regex matcher.
 *
 * Compiles multiple regex patterns into a single
 * automaton for the main matching path. Standard
 * scans use Rust's DFA engine without catastrophic
 * backtracking. Some lookaround cases may use a
 * targeted fallback verifier to preserve
 * correctness. Uses Rust regex syntax for string
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
  private _inner: NativeRegexSetInstance;
  private _names: (string | undefined)[];
  private _hasNames: boolean;
  private _patternCount: number;
  private _nativeIndexMap: number[];
  private _jsFallbacks: JsFallback[];
  private _nativeSingles: NativeSingle[];
  private _boundaryOptions: BoundaryOptions;

  constructor(patterns: PatternEntry[], options?: Options) {
    const entries = patterns.map(normalizeEntry);
    this._names = entries.map((e) => e.name);
    this._hasNames = entries.some(
      (e) => e.name !== undefined,
    );
    this._patternCount = entries.length;

    const unicode = options?.unicodeBoundaries ?? true;
    const wholeWords = options?.wholeWords ?? false;
    const ci = options?.caseInsensitive ?? false;
    this._boundaryOptions = {
      wholeWords,
      unicodeBoundaries: unicode,
    };

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
          const last = src.at(-1);
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
    const nativeOpts: NativeOptions | undefined = options
      ? {
          ...(options.wholeWords !== undefined
            ? { wholeWords: options.wholeWords }
            : {}),
          ...(options.unicodeBoundaries !== undefined
            ? {
                unicodeBoundaries:
                  options.unicodeBoundaries,
              }
            : {}),
        }
      : undefined;

    const nativePatterns: string[] = [];
    this._nativeIndexMap = [];
    this._jsFallbacks = [];
    this._nativeSingles = [];

    for (let i = 0; i < processed.length; i++) {
      const pattern = processed[i];
      if (pattern === undefined) {
        throw new Error(`Missing processed pattern ${i}`);
      }
      const jsFallback = jsFallbackRegExp(pattern, unicode);
      if (jsFallback) {
        this._jsFallbacks.push({
          pattern: i,
          re: jsFallback,
        });
      } else {
        this._nativeIndexMap.push(i);
        nativePatterns.push(pattern);
      }
    }

    this._inner = new binding.RegexSet(
      nativePatterns,
      nativeOpts,
    );
    if (this._jsFallbacks.length > 0) {
      this._nativeSingles = nativePatterns.map(
        (pattern, i) => {
          const original = this._nativeIndexMap[i];
          if (original === undefined) {
            throw new Error(
              `Missing native index map ${i}`,
            );
          }
          return {
            pattern: original,
            inner: new binding.RegexSet(
              [pattern],
              nativeOpts,
            ),
          };
        },
      );
    }
  }

  /** Number of patterns. */
  get patternCount(): number {
    return this._patternCount;
  }

  /** Returns `true` if any pattern matches. */
  isMatch(haystack: string): boolean {
    if (this._inner._isMatchBuf(encoder.encode(haystack))) {
      return true;
    }
    for (const fb of this._jsFallbacks) {
      if (this.findFirstJsFallback(haystack, fb))
        return true;
    }
    return false;
  }

  /** Find all non-overlapping matches. */
  findIter(haystack: string): Match[] {
    if (this._jsFallbacks.length > 0) {
      const all = this.findNativeSingles(haystack).concat(
        this.findJsFallbacks(haystack),
      );
      return selectNonOverlapping(all);
    }

    const native = unpack(
      this._inner._findIterPackedBuf(
        encoder.encode(haystack),
      ),
      haystack,
      this._hasNames ? this._names : null,
      this._nativeIndexMap,
    );
    return native;
  }

  /** Which pattern indices matched (not where). */
  whichMatch(haystack: string): number[] {
    const seen = new Set<number>();
    for (const pattern of this._inner.whichMatch(
      haystack,
    )) {
      const original = this._nativeIndexMap[pattern];
      if (original === undefined) {
        throw new Error(
          `Missing native index map ${pattern}`,
        );
      }
      seen.add(original);
    }
    for (const fb of this._jsFallbacks) {
      if (this.findFirstJsFallback(haystack, fb)) {
        seen.add(fb.pattern);
      }
    }
    return [...seen];
  }

  /**
   * Replace all non-overlapping matches.
   * `replacements[i]` replaces pattern `i`.
   */
  replaceAll(
    haystack: string,
    replacements: string[],
  ): string {
    if (
      this._jsFallbacks.length === 0 &&
      this._nativeIndexMap.length === this._patternCount &&
      this._nativeIndexMap.every((idx, i) => idx === i)
    ) {
      return this._inner.replaceAll(haystack, replacements);
    }
    if (replacements.length !== this._patternCount) {
      throw new Error(
        `Expected ${this._patternCount} ` +
          `replacements, got ${replacements.length}`,
      );
    }

    const matches = this.findIter(haystack);
    let result = "";
    let last = 0;

    for (const m of matches) {
      result += haystack.slice(last, m.start);
      const replacement = replacements[m.pattern];
      if (replacement === undefined) {
        throw new Error(
          `Missing replacement for pattern ${m.pattern}`,
        );
      }
      result += replacement;
      last = m.end;
    }

    result += haystack.slice(last);
    return result;
  }

  private findJsFallbacks(haystack: string): Match[] {
    const matches: Match[] = [];
    for (const fb of this._jsFallbacks) {
      fb.re.lastIndex = 0;
      for (;;) {
        const m = fb.re.exec(haystack);
        if (!m) break;
        const text = m[0];
        const start = m.index;
        const end = start + text.length;
        if (
          this.acceptJsFallbackMatch(haystack, start, end)
        ) {
          const match: Match = {
            pattern: fb.pattern,
            start,
            end,
            text,
          };
          const name = this._names[fb.pattern];
          if (name !== undefined) match.name = name;
          matches.push(match);
          if (text.length === 0) {
            fb.re.lastIndex = nextRegexStart(
              haystack,
              start,
            );
          }
        } else {
          fb.re.lastIndex = nextRegexStart(haystack, start);
        }
      }
    }
    return matches;
  }

  private findNativeSingles(haystack: string): Match[] {
    const encoded = encoder.encode(haystack);
    const matches: Match[] = [];
    for (const single of this._nativeSingles) {
      matches.push(
        ...unpack(
          single.inner._findIterPackedBuf(encoded),
          haystack,
          this._hasNames ? this._names : null,
          [single.pattern],
        ),
      );
    }
    return matches;
  }

  private findFirstJsFallback(
    haystack: string,
    fb: JsFallback,
  ): boolean {
    fb.re.lastIndex = 0;
    for (;;) {
      const m = fb.re.exec(haystack);
      if (!m) return false;
      const text = m[0];
      const start = m.index;
      const end = start + text.length;
      if (
        this.acceptJsFallbackMatch(haystack, start, end)
      ) {
        return true;
      }
      fb.re.lastIndex = nextRegexStart(haystack, start);
    }
  }

  private acceptJsFallbackMatch(
    haystack: string,
    start: number,
    end: number,
  ): boolean {
    if (!this._boundaryOptions.wholeWords) return true;
    return (
      isWordBoundary(
        haystack,
        start,
        this._boundaryOptions.unicodeBoundaries,
      ) &&
      isWordBoundary(
        haystack,
        end,
        this._boundaryOptions.unicodeBoundaries,
      )
    );
  }
}

function jsFallbackRegExp(
  pattern: string,
  unicodeBoundaries: boolean,
): RegExp | undefined {
  if (
    !hasLookaround(pattern) ||
    (unicodeBoundaries && hasRegexWordBoundary(pattern)) ||
    hasRustUnicodeShorthand(pattern) ||
    hasRustClassSetOperation(pattern) ||
    countAlternations(pattern) < 128
  ) {
    return undefined;
  }
  try {
    return new RegExp(pattern, "gu");
  } catch {
    return undefined;
  }
}

function hasLookaround(pattern: string): boolean {
  return (
    pattern.includes("(?=") ||
    pattern.includes("(?!") ||
    pattern.includes("(?<=") ||
    pattern.includes("(?<!")
  );
}

function countAlternations(pattern: string): number {
  let count = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "|" && !inClass) count++;
  }
  return count;
}

function hasRegexWordBoundary(pattern: string): boolean {
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (!inClass && (next === "b" || next === "B")) {
        return true;
      }
      i++;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
  }
  return false;
}

function hasRustUnicodeShorthand(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch !== "\\") continue;
    const next = pattern[i + 1];
    if (
      next === "d" ||
      next === "D" ||
      next === "w" ||
      next === "W" ||
      next === "s" ||
      next === "S"
    ) {
      return true;
    }
    i++;
  }
  return false;
}

function hasRustClassSetOperation(
  pattern: string,
): boolean {
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "]") {
      inClass = false;
      continue;
    }
    if (
      inClass &&
      i + 1 < pattern.length &&
      ((ch === "&" && pattern[i + 1] === "&") ||
        (ch === "-" && pattern[i + 1] === "-") ||
        (ch === "~" && pattern[i + 1] === "~"))
    ) {
      return true;
    }
  }
  return false;
}

function nextRegexStart(
  text: string,
  index: number,
): number {
  if (index >= text.length) return index + 1;
  const first = text.charCodeAt(index);
  if (
    first >= 0xd800 &&
    first <= 0xdbff &&
    index + 1 < text.length
  ) {
    const second = text.charCodeAt(index + 1);
    if (second >= 0xdc00 && second <= 0xdfff) {
      return index + 2;
    }
  }
  return index + 1;
}

function selectNonOverlapping(matches: Match[]): Match[] {
  if (matches.length <= 1) return matches;

  matches.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    const lengthOrder = b.end - b.start - (a.end - a.start);
    if (lengthOrder !== 0) return lengthOrder;
    return a.pattern - b.pattern;
  });

  const selected: Match[] = [];
  let lastEnd = 0;
  for (const m of matches) {
    if (m.start >= lastEnd) {
      selected.push(m);
      lastEnd = m.end;
    }
  }
  return selected;
}

function isWordBoundary(
  text: string,
  pos: number,
  unicode: boolean,
): boolean {
  const before = previousCodePoint(text, pos);
  const after = nextCodePoint(text, pos);
  return (
    isWordChar(before, unicode) !==
    isWordChar(after, unicode)
  );
}

function previousCodePoint(
  text: string,
  pos: number,
): string | undefined {
  if (pos <= 0) return undefined;
  return Array.from(text.slice(0, pos)).at(-1);
}

function nextCodePoint(
  text: string,
  pos: number,
): string | undefined {
  if (pos >= text.length) return undefined;
  const cp = text.codePointAt(pos);
  return cp === undefined
    ? undefined
    : String.fromCodePoint(cp);
}

function isWordChar(
  ch: string | undefined,
  unicode: boolean,
): boolean {
  if (ch === undefined) return false;
  return unicode
    ? /^[\p{Alphabetic}\p{Number}_]$/u.test(ch)
    : /^[A-Za-z0-9_]$/.test(ch);
}
