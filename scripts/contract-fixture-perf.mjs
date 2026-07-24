import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { RegexSet } from "../src/index.ts";

const DEFAULT_MAX_FIND_MS = 5_000;

const fixtureNames = [
  [
    "edgar employment agreement",
    "en/pra-group-employment-agreement.txt",
  ],
  [
    "czech nakit legal services framework",
    "cs/nakit-legal-services-framework.txt",
  ],
];

const PREPARED_CONFIG_PATH = join(
  "crates",
  "anonymize-core",
  "tests",
  "fixtures",
  "assemble",
  "baseline-all-on.expected.json",
);

const candidateAnonymizeDirs = [
  process.env.ANONYMIZE_REPOSITORY_DIR,
  resolve(process.cwd(), ".perf/anonymize"),
  resolve(process.cwd(), "../anonymize"),
].filter((value) => value !== undefined);

const anonymizeDir = candidateAnonymizeDirs.find(
  (candidate) =>
    existsSync(join(candidate, PREPARED_CONFIG_PATH)),
);

if (!anonymizeDir) {
  throw new Error(
    "Set ANONYMIZE_REPOSITORY_DIR to an anonymize repository checkout",
  );
}

const preparedConfig = JSON.parse(
  readFileSync(
    join(anonymizeDir, PREPARED_CONFIG_PATH),
    "utf8",
  ),
);

const maxFindMs = Number(
  process.env.REGEX_SET_CONTRACT_MAX_FIND_MS ??
    DEFAULT_MAX_FIND_MS,
);

const countAlternations = (pattern) => {
  let count = 1;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
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
    if (ch === "|" && !inClass) count++;
  }
  return count;
};

const candidates = [];
for (const [
  index,
  entry,
] of preparedConfig.regex_patterns.entries()) {
  if (entry.kind !== "regex") continue;

  const alternations = countAlternations(entry.pattern);
  if (alternations < 64) continue;

  candidates.push({
    index,
    pattern: entry.pattern,
    meta: preparedConfig.regex_meta[index],
    alternations,
  });
}

if (candidates.length === 0) {
  throw new Error(
    "The anonymize assembly oracle contains no large regex candidates",
  );
}

console.log(
  JSON.stringify({
    event: "candidates",
    sourcePatterns: preparedConfig.regex_patterns.length,
    count: candidates.length,
    candidates: candidates.map((candidate) => ({
      index: candidate.index,
      label: candidate.meta?.label,
      alternations: candidate.alternations,
      length: candidate.pattern.length,
    })),
  }),
);

for (const [fixtureName, relativePath] of fixtureNames) {
  const text = readFileSync(
    join(
      anonymizeDir,
      "packages",
      "anonymize",
      "src/__test__/fixtures/contracts",
      relativePath,
    ),
    "utf8",
  );

  for (const candidate of candidates) {
    const regexSet = new RegexSet([candidate.pattern]);
    const start = Bun.nanoseconds();
    const matches = regexSet.findIter(text);
    const findMs = (Bun.nanoseconds() - start) / 1_000_000;

    console.log(
      JSON.stringify({
        event: "fixture-pattern",
        fixture: fixtureName,
        index: candidate.index,
        label: candidate.meta?.label,
        alternations: candidate.alternations,
        nativePatterns: Reflect.get(
          regexSet,
          "_nativeIndexMap",
        ).length,
        findMs,
        matches: matches.length,
      }),
    );

    if (findMs > maxFindMs) {
      throw new Error(
        `${fixtureName} pattern ${candidate.index} exceeded ` +
          `${maxFindMs}ms: ${findMs.toFixed(2)}ms`,
      );
    }
  }
}
