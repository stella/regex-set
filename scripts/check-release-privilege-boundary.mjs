import { YAML } from "bun";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const JOB_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const isRecord = (value) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value);

const stepRunFingerprint = ({ name, run }) => ({
  name,
  sha256: createHash("sha256").update(run).digest("hex"),
});

const fingerprint = (value) =>
  createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");

const secretReferences = (
  value,
  path = "",
  insideSecrets = false,
) => {
  if (typeof value === "string") {
    if (
      insideSecrets ||
      /\bsecrets(?:\.|\[|\s*(?:\}\}|\)))/.test(value)
    ) {
      return [`${path}=${value}`];
    }
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      secretReferences(
        entry,
        `${path}[${index}]`,
        insideSecrets,
      ),
    );
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) =>
    secretReferences(
      entry,
      path === "" ? key : `${path}.${key}`,
      insideSecrets || key === "secrets",
    ),
  );
};

const effectiveWriteGrants = ({
  jobBodies,
  workflowPermissions,
}) =>
  [...jobBodies]
    .flatMap(([jobName, job]) => {
      const permissions =
        job.permissions ?? workflowPermissions;
      if (permissions === "write-all") {
        return [`${jobName}:write-all`];
      }
      assert(
        isRecord(permissions),
        `${jobName} permissions are not a mapping`,
      );
      return Object.entries(permissions)
        .filter(([, access]) => access === "write")
        .map(([permission]) => `${jobName}:${permission}`);
    })
    .sort((left, right) => left.localeCompare(right));

export const parseJobBodies = (workflow) => {
  const parsedWorkflow = YAML.parse(workflow);
  assert(
    isRecord(parsedWorkflow),
    "release workflow is not a mapping",
  );
  assert(
    isRecord(parsedWorkflow.jobs),
    "release workflow has no jobs",
  );

  const jobBodies = new Map(
    Object.entries(parsedWorkflow.jobs),
  );
  assert(
    jobBodies.size > 0,
    "release workflow has no jobs",
  );
  for (const [job, definition] of jobBodies) {
    assert.match(
      job,
      JOB_ID,
      `release workflow has invalid job ID ${job}`,
    );
    assert(
      isRecord(definition),
      `${job} job is not a mapping`,
    );
  }

  return { jobBodies, parsedWorkflow };
};

export const parseStepRuns = (job) => {
  const steps = job.steps ?? [];
  assert(
    Array.isArray(steps),
    "job steps are not a sequence",
  );
  const runs = [];
  for (const step of steps) {
    assert(
      isRecord(step),
      "workflow step is not a mapping",
    );
    if (step.run === undefined) continue;
    assert.equal(
      typeof step.run,
      "string",
      "step run is not a string",
    );
    assert(
      step.name === undefined ||
        typeof step.name === "string",
      "step name is not a string",
    );
    runs.push({ name: step.name, run: step.run });
  }
  return runs;
};

export const checkReleasePrivilegeBoundary = (workflow) => {
  const { jobBodies, parsedWorkflow } =
    parseJobBodies(workflow);
  assert.deepEqual(parsedWorkflow.permissions, {
    contents: "read",
  });
  const workflowScope = Object.fromEntries(
    Object.entries(parsedWorkflow).filter(
      ([key]) => key !== "jobs",
    ),
  );
  assert.equal(
    fingerprint(workflowScope),
    "ed48301ba410bbcd4a4f211ce6c7a4d90aebec8242391cc522830441ab28d5a9",
    "release workflow scope changed",
  );
  assert.deepEqual(
    secretReferences(parsedWorkflow),
    [
      "jobs.finalize.secrets.RELEASE_APP_ID=${{ secrets.CHANGELOG_APP_ID }}",
      "jobs.finalize.secrets.RELEASE_APP_PRIVATE_KEY=${{ secrets.CHANGELOG_APP_PRIVATE_KEY }}",
    ],
    "release secret allowlist changed",
  );

  const body = (job) => {
    const definition = jobBodies.get(job);
    assert(
      definition,
      `release workflow is missing the ${job} job`,
    );
    return definition;
  };

  const oidcJobs = [...jobBodies]
    .filter(([, job]) => {
      const permissions =
        job.permissions ?? parsedWorkflow.permissions;
      return (
        permissions === "write-all" ||
        (isRecord(permissions) &&
          permissions["id-token"] === "write")
      );
    })
    .map(([job]) => job)
    .sort((left, right) => left.localeCompare(right));
  assert.deepEqual(
    oidcJobs,
    ["attest", "core", "finalize"],
    "release OIDC job allowlist changed",
  );
  assert.deepEqual(
    effectiveWriteGrants({
      jobBodies,
      workflowPermissions: parsedWorkflow.permissions,
    }),
    [
      "attest:attestations",
      "attest:id-token",
      "core:id-token",
      "finalize:contents",
      "finalize:id-token",
    ],
    "release write-permission allowlist changed",
  );

  const uses = (job) => {
    const definition = body(job);
    const references = [];
    if (definition.uses !== undefined) {
      assert.equal(typeof definition.uses, "string");
      references.push(definition.uses);
    }
    const steps = definition.steps ?? [];
    assert(
      Array.isArray(steps),
      `${job} steps are not a sequence`,
    );
    for (const step of steps) {
      assert(
        isRecord(step),
        `${job} step is not a mapping`,
      );
      if (step.uses === undefined) continue;
      assert.equal(typeof step.uses, "string");
      references.push(step.uses);
    }
    return references;
  };
  assert.deepEqual(
    uses("attest"),
    [
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
      "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
      "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
    ],
    "attest action allowlist changed",
  );
  assert.deepEqual(
    uses("core"),
    [
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "dtolnay/rust-toolchain@29eef336d9b2848a0b548edc03f92a220660cdb8",
      "rust-lang/crates-io-auth-action@c6f97d42243bad5fab37ca0427f495c86d5b1a18",
    ],
    "core action allowlist changed",
  );
  assert.deepEqual(
    uses("finalize"),
    [
      "stella/.github/.github/workflows/npm-version-finalize.yml@1ce0079bbdbf93a4c1917d2857496b89aedcec14",
    ],
    "finalize action allowlist changed",
  );

  // Hash parsed YAML scalars so every privileged shell change requires review.
  const privilegedRunAllowlist = {
    attest: [
      {
        name: "Resolve package tarballs",
        sha256:
          "a7159352fc80edabd0065cefb7936d9f297bc671fd02fa3cce2a3cf0974b9189",
      },
    ],
    core: [
      {
        name: "Check exact crates.io version",
        sha256:
          "5fafc87d126f09a4457d132552c58820559499783e5f6e9a6b64f89a1c6515e4",
      },
      {
        name: "Publish Rust core",
        sha256:
          "e4aca45f118e2c90ecb3abf74a4b9223de1fbfe8fc3c72df119926c6b34f268a",
      },
      {
        name: "Verify exact crates.io release",
        sha256:
          "53dd7404c526efb3633177eb0351feca650d9ec8bcaf445bfa235c4b95721947",
      },
    ],
    finalize: [],
  };
  for (const job of oidcJobs) {
    const fingerprints = parseStepRuns(body(job)).map(
      stepRunFingerprint,
    );
    assert.deepEqual(
      fingerprints,
      privilegedRunAllowlist[job],
      `${job} privileged run-step allowlist changed`,
    );
  }

  assert(
    parseStepRuns(body("core-package")).some(({ run }) =>
      run.includes("cargo publish --dry-run"),
    ),
    "core package dry run is missing",
  );
  assert(
    parseStepRuns(body("core")).some(({ run }) =>
      /cargo publish[\s\S]*--no-verify/.test(run),
    ),
    "core publish command must skip the privileged verification build",
  );
  const publishStep = body("core").steps.find(
    (step) => step.name === "Publish Rust core",
  );
  assert.deepEqual(
    {
      cargoHome: publishStep?.env?.CARGO_HOME,
      workingDirectory: publishStep?.["working-directory"],
    },
    {
      cargoHome: "${{ runner.temp }}/release-cargo-home",
      workingDirectory: "${{ runner.temp }}",
    },
    "core publish must isolate Cargo configuration from the checkout",
  );
  assert.deepEqual(body("finalize").secrets, {
    RELEASE_APP_ID: "${{ secrets.CHANGELOG_APP_ID }}",
    RELEASE_APP_PRIVATE_KEY:
      "${{ secrets.CHANGELOG_APP_PRIVATE_KEY }}",
  });

  const privilegedJobFingerprints = {
    attest:
      "b2c6c78e653abb881a434696a3519444dd68ac036391104ebe137d5be1ff611f",
    core: "29cb45984048cde62c5c7d20cfd7b4a871d13b31c4ac6f6d1e0b80b199def1ce",
    finalize:
      "a0adf533b4e837d9fcf1c357e26ce38b31a31de20af3cab667c8bcdd5da6f2bd",
  };
  for (const job of oidcJobs) {
    assert.equal(
      fingerprint(body(job)),
      privilegedJobFingerprints[job],
      `${job} privileged step allowlist changed`,
    );
  }
};

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href ===
    import.meta.url;
if (isMain) {
  const workflow = await readFile(
    new URL(
      "../.github/workflows/release.yml",
      import.meta.url,
    ),
    "utf8",
  );
  checkReleasePrivilegeBoundary(workflow);
}
