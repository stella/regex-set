/**
 * @stll/regex-set benchmark suite
 *
 * Patterns from:
 * - mariomka/regex-benchmark (email, URI, IPv4)
 * - rust-leipzig/regex-performance (Twain corpus)
 * - Catastrophic backtracking resistance
 * - Multi-pattern scenarios
 *
 * Notes:
 * - multi-pattern JS baselines apply the same
 *   non-overlapping selection policy as RegexSet
 * - the mariomka patterns are ASCII-normalized for
 *   JS/Rust parity
 *
 * Run: bun run bench
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { RegexSet } from "../src/index";

const CORPUS = join(__dirname, "corpus");
const load = (f: string) =>
  readFileSync(join(CORPUS, f), "utf-8");

let mariomka: string;
let twain: string;
let bible: string;

try {
  mariomka = load("input-text.txt");
  twain = load("3200.txt");
  bible = load("bible.txt");
} catch {
  console.error(
    "Corpus not found. Download:\n" +
      "  curl -sLO https://raw.githubusercontent.com/" +
      "mariomka/regex-benchmark/master/input-text.txt\n" +
      "  curl -sLO https://raw.githubusercontent.com/" +
      "rust-leipzig/regex-performance/master/3200.txt",
  );
  process.exit(1);
}

// ─── Harness ──────────────────────────────────

const bench = (
  name: string,
  fn: () => number,
  n: number,
) => {
  for (let i = 0; i < 2; i++) fn();
  const t = performance.now();
  let c = 0;
  for (let i = 0; i < n; i++) c = fn();
  const ms = (performance.now() - t) / n;
  console.log(
    `  ${name.padEnd(45)}` +
      `${ms.toFixed(2).padStart(10)} ms ` +
      `${String(c).padStart(8)} matches`,
  );
  return { ms, matches: c };
};

const jsRegexBench = (
  name: string,
  patterns: RegExp[],
  hay: string,
  n: number,
) => {
  const fn = () => {
    let count = 0;
    for (const re of patterns) {
      re.lastIndex = 0;
      for (const _ of hay.matchAll(re)) count++;
    }
    return count;
  };
  return bench(name, fn, n);
};

const jsRegexSetBench = (
  name: string,
  patterns: RegExp[],
  hay: string,
  n: number,
) => {
  const fn = () => {
    const all: Array<[start: number, end: number]> = [];
    for (const re of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(hay)) !== null) {
        const text = m[0]!;
        all.push([m.index!, m.index! + text.length]);
        if (text.length === 0) {
          re.lastIndex++;
        }
      }
    }
    all.sort(
      (a, b) => a[0] - b[0] || (b[1] - b[0]) - (a[1] - a[0]),
    );
    let count = 0;
    let lastEnd = 0;
    for (const [start, end] of all) {
      if (start >= lastEnd) {
        count++;
        lastEnd = end;
      }
    }
    return count;
  };
  return bench(name, fn, n);
};

const reportCountAgreement = (
  label: string,
  left: number,
  right: number,
) => {
  if (left !== right) {
    console.warn(
      `  WARNING: ${label} count mismatch ` +
        `(@stll/regex-set=${left}, JS RegExp=${right})`,
    );
  }
};

const N = 3;

console.log("=".repeat(65));
console.log(" @stll/regex-set benchmark");
console.log("=".repeat(65));

// ─── 1. mariomka: Email, URI, IPv4 ───────────

console.log(
  `\n### mariomka corpus ` +
    `(${(mariomka.length / 1e6).toFixed(1)} MB)\n`,
);

// Use explicit ASCII classes here so JS RegExp and
// Rust regex operate on the same character set.
const mariomkaPatterns = [
  "[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+\\.[A-Za-z0-9.-]+",
  "[A-Za-z0-9_]+://[^/\\s?#]+[^\\s?#]+(?:\\?[^\\s#]*)?(?:#[^\\s]*)?",
  "(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9])",
];

const rsM = new RegexSet(mariomkaPatterns);
const mariomkaRust = bench(
  "@stll/regex-set (3 patterns, 1 pass)",
  () => rsM.findIter(mariomka).length,
  N,
);

const mariomkaJs = jsRegexSetBench(
  "JS RegExp (3 patterns, 3 passes + select)",
  mariomkaPatterns.map((p) => new RegExp(p, "g")),
  mariomka,
  N,
);
reportCountAgreement(
  "mariomka corpus",
  mariomkaRust.matches,
  mariomkaJs.matches,
);

// ─── 2. rust-leipzig: Twain patterns ─────────

console.log(
  `\n### rust-leipzig / Twain corpus ` +
    `(${(twain.length / 1e6).toFixed(1)} MB)\n`,
);

// Pattern 1: simple literal
// NOTE: for pure literal string matching, use
// @stll/aho-corasick instead of regex-set. V8's
// Irregexp uses SIMD-optimized memchr for single
// literals, which is faster than any regex engine.
// regex-set's strength is multi-pattern and regex
// patterns, not literal search.
const rsTwain1 = new RegexSet(["Twain"]);
const twain1Rust = bench(
  "#1 literal: Twain (use aho-corasick instead)",
  () => rsTwain1.findIter(twain).length,
  N,
);
const twain1Js = jsRegexBench(
  "#1 JS: Twain (V8 SIMD fast path)",
  [/Twain/g],
  twain,
  N,
);
reportCountAgreement(
  "#1 literal: Twain",
  twain1Rust.matches,
  twain1Js.matches,
);

// Pattern 3: char class
const rsTwain3 = new RegexSet(["[a-z]shing"]);
const twain3Rust = bench(
  "#3 char class: [a-z]shing",
  () => rsTwain3.findIter(twain).length,
  N,
);
const twain3Js = jsRegexBench(
  "#3 JS: [a-z]shing",
  [/[a-z]shing/g],
  twain,
  N,
);
reportCountAgreement(
  "#3 char class: [a-z]shing",
  twain3Rust.matches,
  twain3Js.matches,
);

// Pattern 5: word boundary
const rsTwain5 = new RegexSet(["\\b\\w+nn\\b"]);
const twain5Rust = bench(
  "#5 word boundary: \\b\\w+nn\\b",
  () => rsTwain5.findIter(twain).length,
  N,
);
const twain5Js = jsRegexBench(
  "#5 JS: \\b\\w+nn\\b",
  [/\b\w+nn\b/g],
  twain,
  N,
);
reportCountAgreement(
  "#5 word boundary: \\b\\w+nn\\b",
  twain5Rust.matches,
  twain5Js.matches,
);

// Pattern 7: multi-alternation
const rsTwain7 = new RegexSet([
  "Tom|Sawyer|Huckleberry|Finn",
]);
const twain7Rust = bench(
  "#7 alternation: Tom|Sawyer|...",
  () => rsTwain7.findIter(twain).length,
  N,
);
const twain7Js = jsRegexBench(
  "#7 JS: Tom|Sawyer|...",
  [/Tom|Sawyer|Huckleberry|Finn/g],
  twain,
  N,
);
reportCountAgreement(
  "#7 alternation",
  twain7Rust.matches,
  twain7Js.matches,
);

// Pattern 12: suffix matching
const rsTwain12 = new RegexSet(["[a-zA-Z]+ing"]);
const twain12Rust = bench(
  "#12 suffix: [a-zA-Z]+ing",
  () => rsTwain12.findIter(twain).length,
  N,
);
const twain12Js = jsRegexBench(
  "#12 JS: [a-zA-Z]+ing",
  [/[a-zA-Z]+ing/g],
  twain,
  N,
);
reportCountAgreement(
  "#12 suffix: [a-zA-Z]+ing",
  twain12Rust.matches,
  twain12Js.matches,
);

// ─── 3. Multi-pattern (our key advantage) ────

console.log(
  `\n### Multi-pattern ` +
    `(bible.txt ${(bible.length / 1e6).toFixed(1)} MB)\n`,
);

const multiPatterns = [
  "[0-9]{2}\\.[0-9]{2}\\.[0-9]{4}",
  "[\\w\\.+-]+@[\\w\\.-]+\\.[\\w\\.-]+",
  "(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9])",
  "\\b[A-Z][a-z]+\\b",
  "\\b\\d+:\\d+\\b",
];

const rsMulti = new RegexSet(multiPatterns);
const multiRust = bench(
  "@stll/regex-set (5 patterns, 1 pass)",
  () => rsMulti.findIter(bible).length,
  N,
);
const multiJs = jsRegexSetBench(
  "JS RegExp (5 patterns, 5 passes + select)",
  multiPatterns.map((p) => new RegExp(p, "g")),
  bible,
  N,
);
reportCountAgreement(
  "bible multi-pattern",
  multiRust.matches,
  multiJs.matches,
);

// ─── 4. Catastrophic backtracking resistance ─

console.log("\n### Catastrophic backtracking resistance\n");

// (a+)+$ on "aaa...X" — hangs JS, instant in Rust
const evil = "a".repeat(25) + "X";
const rsEvil = new RegexSet(["(a+)+$"]);
const t1 = performance.now();
rsEvil.isMatch(evil);
const rustTime = performance.now() - t1;
console.log(
  `  (a+)+$ on ${evil.length} chars:` +
    `   Rust ${rustTime.toFixed(2)} ms` +
    ` (JS would hang)`,
);

// Cloudflare ReDoS pattern (simplified)
const cfPattern = ".*.*=.*";
const cfInput = "x".repeat(30) + "=" + "y".repeat(30);
const rsCf = new RegexSet([cfPattern]);
const t2 = performance.now();
rsCf.isMatch(cfInput);
const cfTime = performance.now() - t2;
console.log(
  `  .*.*=.* on ${cfInput.length} chars:` +
    `  Rust ${cfTime.toFixed(2)} ms`,
);

// ─── 5. Lookaround patterns (prefiltered) ────

console.log(
  `\n### Lookaround (prefiltered DFA + verify)\n`,
);

const lookPatterns = [
  "[0-9]{2}\\.[0-9]{2}\\.[0-9]{4}",
  "(?<!\\p{L})\\b[A-Z][a-z]+\\b",
  "[0-9]+(?![0-9])",
];

const rsLook = new RegexSet(lookPatterns);
const lookRust = bench(
  "@stll/regex-set (3 patterns, lookaround)",
  () => rsLook.findIter(bible).length,
  N,
);
const lookJs = jsRegexSetBench(
  "JS RegExp (3 patterns, lookaround + select)",
  [
    /[0-9]{2}\.[0-9]{2}\.[0-9]{4}/g,
    /(?<!\p{L})\b[A-Z][a-z]+\b/gu,
    /[0-9]+(?![0-9])/g,
  ],
  bible,
  N,
);
reportCountAgreement(
  "bible lookaround",
  lookRust.matches,
  lookJs.matches,
);

console.log("\n" + "=".repeat(65));
console.log(" Done.");
console.log("=".repeat(65));
