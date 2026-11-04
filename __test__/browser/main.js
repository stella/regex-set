// Runs the packed @stll/regex-set-wasm package in the browser and writes the
// outcome into #out for check.mjs.
import singleThreadWasmUrl from "@stll/regex-set-wasm/single-thread/wasm?url";

const out = document.getElementById("out");

const assertEqual = (label, actual, expected) => {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
  }
};

const haystack = "Smlouva č. 2024/15 ze dne 15.03.2024, e-mail jana@example.cz";
const patterns = [
  String.raw`\b\d{2}\.\d{2}\.\d{4}\b`,
  String.raw`\b[\w.+-]+@[\w-]+\.\w+\b`,
];
const expected = [
  { pattern: 0, text: "15.03.2024" },
  { pattern: 1, text: "jana@example.cz" },
];

const search = (label, RegexSet) => {
  const found = new RegexSet(patterns).findIter(haystack);
  for (const match of found) {
    assertEqual(
      `${label} offsets`,
      haystack.slice(match.start, match.end),
      match.text,
    );
  }
  const matches = found.map(({ pattern, text }) => ({ pattern, text }));
  assertEqual(label, matches, expected);
  return matches;
};

try {
  // Default entry: threaded WASI build with its worker.
  const threaded = await import("@stll/regex-set-wasm");
  const matches = search("threaded findIter", threaded.RegexSet);

  // Single-thread entry, initialized from the bundled asset URL.
  const singleThread = await import("@stll/regex-set-wasm/single-thread");
  await singleThread.init(singleThreadWasmUrl);
  search("single-thread findIter", singleThread.RegexSet);

  // Single-thread entry with the embedded module.
  const inline = await import("@stll/regex-set-wasm/single-thread/inline");
  inline.initSync();
  search("inline findIter", inline.RegexSet);

  out.textContent = JSON.stringify({
    ok: true,
    crossOriginIsolated: globalThis.crossOriginIsolated,
    matches,
    entries: ["threaded", "single-thread", "single-thread/inline"],
  });
} catch (error) {
  out.textContent = JSON.stringify({
    ok: false,
    error: String(error?.stack ?? error),
  });
}
