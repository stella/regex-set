import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";

const wasmPath = fileURLToPath(
  new URL("../regex-set.wasm32-wasi.wasm", import.meta.url),
);

try {
  await access(wasmPath, constants.F_OK);
} catch {
  const result = spawnSync("bun", ["run", "build:wasm"], {
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
}
