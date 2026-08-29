import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = await readFile(
  new URL(
    "../.github/workflows/release.yml",
    import.meta.url,
  ),
  "utf8",
);
const jobsIndex = workflow.indexOf("\njobs:\n");
assert.notEqual(
  jobsIndex,
  -1,
  "release workflow has no jobs",
);
const workflowPermissions = workflow.slice(0, jobsIndex);
assert.match(
  workflowPermissions,
  /^permissions:\n  contents: read$/m,
);
assert.doesNotMatch(
  workflowPermissions,
  /id-token:\s*write|write-all/,
);
assert.doesNotMatch(
  workflow,
  /^\s*permissions:\s*write-all\s*$/m,
);

const jobBodies = new Map();
let currentJob;
for (const line of workflow
  .slice(jobsIndex + 7)
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

const uses = (job) =>
  [...body(job).matchAll(/^\s+(?:- )?uses: (\S+)/gm)].map(
    ([, action]) => action,
  );
assert.deepEqual(uses("attest"), [
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
  "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
]);
assert.deepEqual(uses("core"), [
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  "dtolnay/rust-toolchain@29eef336d9b2848a0b548edc03f92a220660cdb8",
  "rust-lang/crates-io-auth-action@c6f97d42243bad5fab37ca0427f495c86d5b1a18",
]);

for (const job of ["attest", "core"]) {
  assert.doesNotMatch(body(job), /uses:\s+\.\//);
  assert.doesNotMatch(
    body(job),
    /\b(?:bun|npm|pnpm|yarn)\s+(?:ci|exec|install|pack|run|x)\b|\bnpx\s+\S/,
    `${job} may not execute package-manager, runtime, or local dependency code`,
  );
  assert.doesNotMatch(
    body(job),
    /^\s+(?:run:\s+)?(?:node|deno|python3?)\s/gm,
    `${job} may not execute a language runtime`,
  );
}
const cargoCommands = body("core").match(
  /^\s+run: cargo .*$/gm,
);
assert.deepEqual(cargoCommands, [
  "        run: cargo publish --package stella-regex-set-core --locked --no-verify",
]);

assert.match(
  body("core-package"),
  /cargo publish --dry-run/,
);
assert.match(body("core"), /cargo publish .*--no-verify/);
assert.match(
  body("finalize"),
  /npm-version-finalize\.yml@1ce0079bbdbf93a4c1917d2857496b89aedcec14/,
);
assert.doesNotMatch(body("finalize"), /secrets:\s*inherit/);
const finalizerSecrets = body("finalize")
  .split("\n")
  .filter((line) => /^      [A-Z_]+:/.test(line));
assert.deepEqual(finalizerSecrets, [
  "      RELEASE_APP_ID: ${{ secrets.CHANGELOG_APP_ID }}",
  "      RELEASE_APP_PRIVATE_KEY: ${{ secrets.CHANGELOG_APP_PRIVATE_KEY }}",
]);
