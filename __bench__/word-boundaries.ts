/** Benchmark JS word-boundary patterns and report their engine routes. */
import { RegexSet } from "../src/index";

const WARMUP = 2;
const ITERATIONS = 5;
const TARGET_BYTES = 4 * 1024 * 1024;

const patterns = Array.from({ length: 50 }, (_, index) => {
  const serial = index + 1;
  return index % 2 === 0
    ? new RegExp(String.raw`\bčl\.\s*${serial}\b`)
    : new RegExp(String.raw`\bIČO:\s*[0-9]{8}\b\s+ref-${serial}\b`);
});
const paragraph = patterns
  .map((_, index) => {
    const serial = index + 1;
    return index % 2 === 0
      ? `Podle čl. ${serial} smlouvy. `
      : `IČO: 12345678 ref-${serial}. `;
  })
  .join("");
const repeats = Math.ceil(TARGET_BYTES / paragraph.length);
const text = paragraph.repeat(repeats);
const set = new RegexSet(patterns);

for (const [index, pattern] of patterns.entries()) {
  const single = new RegexSet([pattern]);
  const [fast = 0, verified = 0, fallback = 0] = single._enginePathCounts();
  let path = "JavaScript fallback";
  if (fast > 0) path = "DFA";
  else if (verified > 0) path = "verified DFA";
  else if (fallback > 0) path = "fallback";
  console.log(`${String(index + 1).padStart(2, "0")}\t${path}`);
}

for (let index = 0; index < WARMUP; index++) {
  set.findIter(text);
}
const times: number[] = [];
let matches = 0;
for (let index = 0; index < ITERATIONS; index++) {
  const start = performance.now();
  matches = set.findIter(text).length;
  times.push(performance.now() - start);
}
times.sort((left, right) => left - right);
console.log(`bytes\t${Buffer.byteLength(text)}`);
console.log(`matches\t${matches}`);
const median = times.at(Math.floor(times.length / 2));
if (median === undefined) throw new Error("No benchmark samples");
console.log(`median_ms\t${median.toFixed(3)}`);
