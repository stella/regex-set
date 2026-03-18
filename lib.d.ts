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
   * Zero performance overhead in either mode —
   * boundaries are verified inline per match.
   * @default false
   */
  unicodeBoundaries?: boolean;
};

/** A named pattern entry. */
export type NamedPattern = {
  /** The regex pattern (string or RegExp). */
  pattern: string | RegExp;
  /** Optional name for this pattern. */
  name?: string;
};

/** A pattern entry: string, RegExp, or named. */
export type PatternEntry =
  | string
  | RegExp
  | NamedPattern;

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
export declare class RegexSet {
  constructor(
    patterns: PatternEntry[],
    options?: Options,
  );

  /** Number of patterns. */
  get patternCount(): number;

  /** Returns `true` if any pattern matches. */
  isMatch(haystack: string): boolean;

  /** Find all non-overlapping matches. */
  findIter(haystack: string): Match[];

  /** Which pattern indices matched (not where). */
  whichMatch(haystack: string): number[];

  /**
   * Replace all non-overlapping matches.
   * `replacements[i]` replaces pattern `i`.
   */
  replaceAll(
    haystack: string,
    replacements: string[],
  ): string;
}
