import { Glob, YAML } from "bun";
import { fileURLToPath } from "node:url";

import {
  readWasiPackage,
  readWasiRootEntry,
  readWasiWorkflow,
} from "./release-script-inputs.mjs";

const root = new URL("../", import.meta.url);
const metadataPrefix = "// napi-rs-artifact-metadata:";

const requiredEntries = async () => {
  const [binding] = new Glob("*.wasi.cjs").scanSync(fileURLToPath(root));
  if (binding === undefined || binding === "") {
    throw new Error("No root WASI binding metadata found");
  }

  const firstLine = (await Bun.file(new URL(binding, root)).text())
    .split("\n", 1)
    .at(0);
  if (firstLine === undefined || !firstLine.startsWith(metadataPrefix)) {
    throw new Error(`${binding} has no NAPI-RS artifact metadata`);
  }

  /** @type {unknown} */
  const metadata = JSON.parse(firstLine.slice(metadataPrefix.length));
  const rootEntry = readWasiRootEntry(metadata);
  return rootEntry === null || rootEntry === ""
    ? ["browser.js"]
    : ["browser.js", rootEntry];
};

const workflowContract = async () => {
  /** @type {unknown} */
  const workflow = YAML.parse(
    await Bun.file(new URL(".github/workflows/release.yml", root)).text(),
  );
  const { targets: workflowTargets, wasmPaths } = readWasiWorkflow(workflow);
  /** @type {unknown} */
  const manifest = await Bun.file(new URL("package.json", root)).json();
  const { targets: napiTargets, scripts } = readWasiPackage(manifest);
  for (const scriptName of ["build:debug", "build:wasm"]) {
    const command = scripts[scriptName];
    if (
      typeof command !== "string" ||
      !command.startsWith("node scripts/build-native.mjs ") ||
      command.includes("&&")
    ) {
      throw new Error(
        `${scriptName} must forward arguments directly to build-native.mjs`,
      );
    }
  }
  if (
    scripts.build !==
    "node scripts/build-native.mjs --platform --dts index.d.cts --release"
  ) {
    throw new Error("build must build only the native binding");
  }
  if (
    workflowTargets.length !== napiTargets.length ||
    workflowTargets.some((target) => !napiTargets.includes(target))
  ) {
    throw new Error("Release build matrix differs from NAPI targets");
  }

  return wasmPaths;
};

/** @param {string[]} patterns
 * @param {string} entry
 */
const isUploaded = (patterns, entry) => {
  const includes = patterns.filter((pattern) => !pattern.startsWith("!"));
  const excludes = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1));
  return (
    includes.some((pattern) => new Glob(pattern).match(entry)) &&
    !excludes.some((pattern) => new Glob(pattern).match(entry))
  );
};

const entries = await requiredEntries();
if (process.argv.includes("--generated")) {
  for (const entry of entries) {
    if (!(await Bun.file(new URL(entry, root)).exists())) {
      throw new Error(`WASI build omitted required root entry ${entry}`);
    }
  }
} else {
  const patterns = await workflowContract();
  for (const entry of entries) {
    if (!isUploaded(patterns, entry)) {
      throw new Error(`Release upload omits required WASI root entry ${entry}`);
    }
  }
}
