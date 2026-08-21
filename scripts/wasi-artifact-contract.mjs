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

const uploadPatterns = async () => {
  const workflow = YAML.parse(
    await Bun.file(
      new URL(".github/workflows/release.yml", root),
    ).text(),
  );
  const upload = workflow?.jobs?.build?.steps?.find(
    (step) => step.name === "Upload bindings",
  );
  if (typeof upload?.with?.path !== "string") {
    throw new Error(
      "Release workflow has no binding upload manifest",
    );
  }
  return upload.with.path.trim().split(/\s+/u);
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
  const patterns = await uploadPatterns();
  for (const entry of entries) {
    if (!isUploaded(patterns, entry)) {
      throw new Error(
        `Release upload omits required WASI root entry ${entry}`,
      );
    }
  }
}
