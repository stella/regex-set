import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = await readFile(
  new URL(
    "../.github/workflows/release.yml",
    import.meta.url,
  ),
  "utf8",
);

const jobBodies = new Map();
let currentJob;
for (const line of workflow
  .slice(workflow.indexOf("\njobs:\n") + 7)
  .split("\n")) {
  const jobStart = line.match(/^  ([a-z][a-z0-9-]+):$/);
  if (jobStart) {
    currentJob = jobStart[1];
    jobBodies.set(currentJob, []);
    continue;
  }
  if (currentJob) jobBodies.get(currentJob).push(line);
}

const body = (job) => {
  const lines = jobBodies.get(job);
  assert(
    lines,
    `release workflow is missing the ${job} job`,
  );
  return lines.join("\n");
};

const oidcJobs = [...jobBodies]
  .filter(([, lines]) =>
    lines.some((line) => /id-token:\s*write/.test(line)),
  )
  .map(([job]) => job)
  .sort((left, right) => left.localeCompare(right));
assert.deepEqual(oidcJobs, ["attest", "core", "finalize"]);

const executableDependencyCode = [
  /\bbun install\b/,
  /\bnpm (?:install|pack)\b/,
  /\bcargo (?:build|package|test)\b/,
  /\bcargo publish\s+--dry-run\b/,
  /\bbun run build(?::\S+)?\b/,
  /uses: oven-sh\/setup-bun@/,
  /uses: Swatinem\/rust-cache@/,
];
for (const job of oidcJobs) {
  for (const pattern of executableDependencyCode) {
    assert.doesNotMatch(
      body(job),
      pattern,
      `${job} executes dependency or build code while holding OIDC`,
    );
  }
}

assert.match(
  body("core-package"),
  /cargo publish --dry-run/,
);
assert.match(body("core"), /cargo publish .*--no-verify/);
assert.match(
  body("finalize"),
  /npm-version-finalize\.yml@1ce0079bbdbf93a4c1917d2857496b89aedcec14/,
);
