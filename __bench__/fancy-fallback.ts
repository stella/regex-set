/**
 * Benchmark: fancy-regex fallback path
 *
 * Measures the performance impact of the DFA verifier
 * rejection + fancy-regex backtracking fallback added
 * in fix/greedy-newline-dfa.
 *
 * Three scenarios:
 * 1. Baseline — pattern without lookahead (no verifier)
 * 2. With verifier, no fallback — lookahead pattern,
 *    text that matches without triggering fallback
 * 3. With verifier, fallback triggers — lookahead
 *    pattern, greedy \s* crosses newline and DFA match
 *    is rejected; fancy-regex backtracks to find the
 *    shorter valid match
 *
 * Run: bun __bench__/fancy-fallback.ts
 */
import { RegexSet } from "../src/index";

// ─── Harness ──────────────────────────────────

const WARMUP = 3;
const ITERS = 10;

const bench = (
  name: string,
  fn: () => number,
): { ms: number; matches: number } => {
  // Warmup
  for (let i = 0; i < WARMUP; i++) fn();

  const times: number[] = [];
  let matches = 0;
  for (let i = 0; i < ITERS; i++) {
    const t = performance.now();
    matches = fn();
    times.push(performance.now() - t);
  }

  times.sort((a, b) => a - b);
  // Median of middle 60%
  const lo = Math.floor(times.length * 0.2);
  const hi = Math.ceil(times.length * 0.8);
  const median =
    times.slice(lo, hi).reduce((a, b) => a + b, 0) /
    (hi - lo);

  console.log(
    `  ${name.padEnd(50)}` +
      `${median.toFixed(3).padStart(10)} ms` +
      `${String(matches).padStart(8)} matches`,
  );
  return { ms: median, matches };
};

// ─── Setup ────────────────────────────────────

const REPS = 2000;

// Pattern WITHOUT lookahead — pure DFA, no verifier
const patBaseline = String.raw`[A-Z][a-z]+\s+a\.[\s]*s\.`;

// Pattern WITH lookahead — has verifier
const patLookahead = String.raw`[A-Z][a-z]+\s+a\.[\s]*s\.[\s]*(?![a-z])`;

// Text where match succeeds without fallback:
// "Vinci a.s." followed by space + uppercase (lookahead
// passes on first DFA match)
const textNoFallback =
  "Vinci a.s. Praha ".repeat(REPS);

// Text where fallback triggers: "Vinci a.s.\nsídlo"
// DFA greedily consumes \s* across the newline,
// lookahead sees 's' (lowercase) and rejects;
// fancy-regex backtracks \s* to find "Vinci a.s."
const textFallback =
  "Vinci a.s.\nsídlo ".repeat(REPS);

// ─── Build RegexSets ──────────────────────────

const rsBaseline = new RegexSet([patBaseline]);
const rsLookahead = new RegexSet([patLookahead]);

// ─── Run ──────────────────────────────────────

console.log("=".repeat(70));
console.log(
  " fancy-regex fallback benchmark" +
    ` (${REPS} repetitions, ${ITERS} iterations)`,
);
console.log("=".repeat(70));
console.log();

const r1 = bench(
  "1. Baseline (no lookahead, pure DFA)",
  () => rsBaseline.findIter(textNoFallback).length,
);

const r2 = bench(
  "2. With verifier, no fallback triggered",
  () => rsLookahead.findIter(textNoFallback).length,
);

const r3 = bench(
  "3. With verifier, fallback triggers (new path)",
  () => rsLookahead.findIter(textFallback).length,
);

console.log();

// Overhead calculations
const overheadVerifier =
  r2.ms > 0 && r1.ms > 0
    ? ((r2.ms - r1.ms) / r1.ms) * 100
    : 0;
const overheadFallback =
  r3.ms > 0 && r2.ms > 0
    ? ((r3.ms - r2.ms) / r2.ms) * 100
    : 0;

console.log(
  `  Verifier overhead (no fallback):  ` +
    `${overheadVerifier > 0 ? "+" : ""}` +
    `${overheadVerifier.toFixed(1)}%`,
);
console.log(
  `  Fallback overhead (vs verifier):  ` +
    `${overheadFallback > 0 ? "+" : ""}` +
    `${overheadFallback.toFixed(1)}%`,
);

// Sanity: verify match counts
console.log();
if (r1.matches !== REPS) {
  console.error(
    `  ERROR: baseline expected ${REPS} matches,` +
      ` got ${r1.matches}`,
  );
}
if (r2.matches !== REPS) {
  console.error(
    `  ERROR: verifier expected ${REPS} matches,` +
      ` got ${r2.matches}`,
  );
}
if (r3.matches !== REPS) {
  console.error(
    `  ERROR: fallback expected ${REPS} matches,` +
      ` got ${r3.matches}`,
  );
}

console.log("=".repeat(70));
console.log(" Done.");
console.log("=".repeat(70));
