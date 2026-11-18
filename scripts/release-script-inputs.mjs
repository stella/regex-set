/** @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** @typedef {Record<string, unknown> & {name: string, version: string, optionalDependencies?: Record<string, string>}} ReleaseManifest */

/** @param {unknown} value
 * @returns {value is ReleaseManifest}
 */
const isReleaseManifest = (value) => {
  if (
    !isRecord(value) ||
    typeof value["name"] !== "string" ||
    typeof value["version"] !== "string"
  )
    return false;
  const optional = value["optionalDependencies"];
  return (
    optional === undefined ||
    (isRecord(optional) &&
      Object.values(optional).every((entry) => typeof entry === "string"))
  );
};

/** @param {string} text */
export const parseReleaseManifest = (text) => {
  /** @type {unknown} */
  const value = JSON.parse(text);
  if (!isReleaseManifest(value))
    throw new TypeError(
      "Release manifest requires string name/version and string optional dependency ranges",
    );
  return value;
};

/** @param {unknown} value */
export const readWasiRootEntry = (value) => {
  if (
    !isRecord(value) ||
    !("rootEntry" in value) ||
    (value["rootEntry"] !== null && typeof value["rootEntry"] !== "string")
  )
    throw new TypeError("WASI metadata requires a string or null root entry");
  return value["rootEntry"];
};

/** @param {unknown} value
 * @returns {string[]}
 */
export const stringArray = (value) => {
  if (!Array.isArray(value))
    throw new TypeError("Release contract requires string arrays");
  return Array.from(
    value,
    /** @param {unknown} entry */ (entry) => {
      if (typeof entry !== "string")
        throw new TypeError("Release contract requires string arrays");
      return entry;
    },
  );
};

// The shared release workflow builds exactly these targets; keep this list in
// step with stella/.github/.github/workflows/rust-napi-release.yml.
export const SHARED_RELEASE_TARGETS = Object.freeze([
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-pc-windows-msvc",
  "wasm32-wasip1-threads",
]);

const SHARED_RELEASE_USE =
  /^stella\/\.github\/\.github\/workflows\/rust-napi-release\.yml@[0-9a-f]{40}$/u;

/** @param {unknown} value */
export const readWasiWorkflow = (value) => {
  if (
    !isRecord(value) ||
    !isRecord(value["jobs"]) ||
    !isRecord(value["jobs"]["test"])
  )
    throw new TypeError("Release workflow requires a test job");
  const job = value["jobs"]["test"];
  if (typeof job["uses"] !== "string" || !SHARED_RELEASE_USE.test(job["uses"]))
    throw new TypeError(
      "Release test job must call the pinned shared native release workflow",
    );
  const inputs = job["with"];
  const wasmPaths = isRecord(inputs)
    ? inputs["wasm-artifact-paths"]
    : undefined;
  if (typeof wasmPaths !== "string")
    throw new TypeError("Release workflow has no WASM upload manifest");
  return {
    targets: [...SHARED_RELEASE_TARGETS],
    wasmPaths: wasmPaths.trim().split(/\s+/u),
  };
};

/** @param {unknown} value */
export const readWasiPackage = (value) => {
  if (
    !isRecord(value) ||
    !isRecord(value["napi"]) ||
    !isRecord(value["scripts"])
  )
    throw new TypeError(
      "Release package requires NAPI targets and build scripts",
    );
  return {
    targets: stringArray(value["napi"]["targets"]),
    scripts: value["scripts"],
  };
};
