import { Glob, YAML } from "bun";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const metadataPrefix = "// napi-rs-artifact-metadata:";

const requiredEntries = async () => {
  const [binding] = new Glob("*.wasi.cjs").scanSync(
    fileURLToPath(root),
  );
  if (!binding) {
    throw new Error("No root WASI binding metadata found");
  }

  const firstLine = (
    await Bun.file(new URL(binding, root)).text()
  )
    .split("\n", 1)
    .at(0);
  if (!firstLine?.startsWith(metadataPrefix)) {
    throw new Error(
      `${binding} has no NAPI-RS artifact metadata`,
    );
  }

  const { rootEntry } = JSON.parse(
    firstLine.slice(metadataPrefix.length),
  );
  if (rootEntry !== null && typeof rootEntry !== "string") {
    throw new Error(`${binding} has an invalid root entry`);
  }
  return ["browser.js", rootEntry].filter(Boolean);
};

const workflowContract = async () => {
  const workflow = YAML.parse(
    await Bun.file(
      new URL(".github/workflows/release.yml", root),
    ).text(),
  );
  const build = workflow?.jobs?.build;
  const settings = build?.strategy?.matrix?.settings;
  if (!Array.isArray(settings)) {
    throw new Error("Release workflow has no build matrix");
  }

  const { napi, scripts } = await Bun.file(
    new URL("package.json", root),
  ).json();
  for (const scriptName of [
    "build",
    "build:debug",
    "build:wasm",
  ]) {
    const command = scripts?.[scriptName];
    if (
      typeof command !== "string" ||
      !command.startsWith(
        "node scripts/build-native.mjs ",
      ) ||
      command.includes("&&")
    ) {
      throw new Error(
        `${scriptName} must forward arguments directly to build-native.mjs`,
      );
    }
  }
  const workflowTargets = settings.map(
    ({ target }) => target,
  );
  if (
    !Array.isArray(napi?.targets) ||
    workflowTargets.length !== napi.targets.length ||
    workflowTargets.some(
      (target) => !napi.targets.includes(target),
    )
  ) {
    throw new Error(
      "Release build matrix differs from NAPI targets",
    );
  }

  const nativeUpload = build.steps?.find(
    (step) => step.name === "Upload native binding",
  );
  if (
    nativeUpload?.with?.path !==
    "${{ matrix.settings.node_artifact }}"
  ) {
    throw new Error(
      "Native uploads must select the matrix artifact",
    );
  }

  const nativeArtifacts = settings
    .filter(
      ({ target }) => target !== "wasm32-wasip1-threads",
    )
    .map(({ node_artifact }) => node_artifact);
  if (
    nativeArtifacts.some(
      (artifact) =>
        typeof artifact !== "string" ||
        !artifact.endsWith(".node") ||
        artifact.includes("*"),
    ) ||
    new Set(nativeArtifacts).size !== nativeArtifacts.length
  ) {
    throw new Error(
      "Each native target must upload one unique binary",
    );
  }

  const wasmUpload = build.steps?.find(
    (step) => step.name === "Upload WASM bindings",
  );
  if (typeof wasmUpload?.with?.path !== "string") {
    throw new Error(
      "Release workflow has no WASM upload manifest",
    );
  }
  return wasmUpload.with.path.trim().split(/\s+/u);
};

const isUploaded = (patterns, entry) => {
  const includes = patterns.filter(
    (pattern) => !pattern.startsWith("!"),
  );
  const excludes = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1));
  return (
    includes.some((pattern) =>
      new Glob(pattern).match(entry),
    ) &&
    !excludes.some((pattern) =>
      new Glob(pattern).match(entry),
    )
  );
};

const entries = await requiredEntries();
if (process.argv.includes("--generated")) {
  for (const entry of entries) {
    if (!(await Bun.file(new URL(entry, root)).exists())) {
      throw new Error(
        `WASI build omitted required root entry ${entry}`,
      );
    }
  }
} else {
  const patterns = await workflowContract();
  for (const entry of entries) {
    if (!isUploaded(patterns, entry)) {
      throw new Error(
        `Release upload omits required WASI root entry ${entry}`,
      );
    }
  }
}
