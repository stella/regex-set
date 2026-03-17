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
};

/**
 * Multi-pattern regex matcher.
 *
 * Compiles multiple regex patterns into a single
 * automaton. Guaranteed O(m * n) — no catastrophic
 * backtracking. Uses Rust regex syntax.
 */
export declare class RegexSet {
  constructor(patterns: string[]);

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
