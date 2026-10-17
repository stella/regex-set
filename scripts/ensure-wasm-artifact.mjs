import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const wasmPath = fileURLToPath(
  new URL("../regex-set.wasm32-wasi.wasm", import.meta.url),
);
const singleThreadPath = fileURLToPath(
  new URL(
    "../regex-set.single-thread.wasm",
    import.meta.url,
  ),
);
const root = fileURLToPath(new URL("../", import.meta.url));

try {
  await access(wasmPath, constants.F_OK);
  await access(singleThreadPath, constants.F_OK);
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

  const result = spawnSync("bun", ["run", "build:wasm"], {
    cwd: root,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}
