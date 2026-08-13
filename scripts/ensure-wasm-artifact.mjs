import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const wasmPath = fileURLToPath(
  new URL("../regex-set.wasm32-wasi.wasm", import.meta.url),
);
const buildScriptPath = fileURLToPath(
  new URL("./build-native.mjs", import.meta.url),
);

try {
  await access(wasmPath, constants.F_OK);
  await access(
    fileURLToPath(
      new URL(
        "../regex-set.wasi-browser.js",
        import.meta.url,
      ),
    ),
    constants.F_OK,
  );
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }

  const result = spawnSync(
    process.execPath,
    [
      buildScriptPath,
      "--platform",
      "--target",
      "wasm32-wasip1-threads",
      "--dts",
      "index.d.cts",
      "--release",
    ],
    {
      stdio: "inherit",
    },
  );

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}
