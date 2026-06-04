import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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

const candidatePackageDirs = [
  process.env.ANONYMIZE_PACKAGE_DIR,
  resolve(
    process.cwd(),
    ".perf/anonymize/packages/anonymize",
  ),
  resolve(process.cwd(), "../anonymize/packages/anonymize"),
  resolve(
    process.cwd(),
    "../anonymize-ts/packages/anonymize",
  ),
].filter((value) => value !== undefined);

const packageDir = candidatePackageDirs.find((candidate) =>
  existsSync(join(candidate, "src/detectors/regex.ts")),
);

if (!packageDir) {
  throw new Error(
    "Set ANONYMIZE_PACKAGE_DIR to an anonymize packages/anonymize checkout",
  );
}

const importFromAnonymize = (relativePath) =>
  import(
    pathToFileURL(join(packageDir, relativePath)).href
  );

const { DEFAULT_ENTITY_LABELS } = await importFromAnonymize(
  "src/constants.ts",
);
const {
  REGEX_PATTERNS,
  REGEX_META,
  CURRENCY_PATTERN_META,
  DATE_PATTERN_META,
  SIGNING_CLAUSE_META,
  getCurrencyPatterns,
  getDatePatterns,
  getSigningClausePatterns,
} = await importFromAnonymize("src/detectors/regex.ts");

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

const allowedLabels = new Set(DEFAULT_ENTITY_LABELS);
const allPatterns = [];
const allMeta = [];

for (const [index, pattern] of REGEX_PATTERNS.entries()) {
  const meta = REGEX_META[index];
  if (!meta || !allowedLabels.has(meta.label)) continue;
  allPatterns.push(pattern);
  allMeta.push(meta);
}

for (const pattern of await getCurrencyPatterns()) {
  allPatterns.push(pattern);
  allMeta.push(CURRENCY_PATTERN_META);
}
for (const pattern of await getDatePatterns()) {
  allPatterns.push(pattern);
  allMeta.push(DATE_PATTERN_META);
}
for (const pattern of await getSigningClausePatterns()) {
  allPatterns.push(pattern);
  allMeta.push(SIGNING_CLAUSE_META);
}

const candidates = allPatterns
  .map((pattern, index) => ({
    index,
    pattern,
    meta: allMeta[index],
    alternations: countAlternations(pattern),
  }))
  .filter((candidate) => candidate.alternations >= 64);

console.log(
  JSON.stringify({
    event: "candidates",
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
      packageDir,
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
