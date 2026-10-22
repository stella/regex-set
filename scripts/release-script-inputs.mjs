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

/** @param {unknown} value */
export const readWasiWorkflow = (value) => {
  if (
    !isRecord(value) ||
    !isRecord(value["jobs"]) ||
    !isRecord(value["jobs"]["build"])
  )
    throw new TypeError("Release workflow requires a build job");
  const build = value["jobs"]["build"];
  const strategy = build["strategy"];
  const matrix = isRecord(strategy) ? strategy["matrix"] : undefined;
  const settings = isRecord(matrix) ? matrix["settings"] : undefined;
  if (!Array.isArray(settings))
    throw new TypeError("Release workflow has no build matrix");
  const targets = Array.from(
    settings,
    /** @param {unknown} setting */ (setting) => {
      if (!isRecord(setting) || typeof setting["target"] !== "string")
        throw new TypeError("Release build settings require target strings");
      const artifact = setting["node_artifact"];
      if (
        setting["target"] !== "wasm32-wasip1-threads" &&
        typeof artifact !== "string"
      )
        throw new TypeError("Native build settings require artifact strings");
      return {
        target: setting["target"],
        node_artifact: artifact,
      };
    },
  );
  const steps = build["steps"];
  if (!Array.isArray(steps))
    throw new TypeError("Release workflow requires build steps");
  const uploads = Array.from(
    steps,
    /** @param {unknown} step */ (step) => {
      if (!isRecord(step))
        throw new TypeError("Release build steps must be objects");
      const inputs = step["with"];
      return {
        name: step["name"],
        path: isRecord(inputs) ? inputs["path"] : undefined,
      };
    },
  );
  return { targets, uploads };
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
