import { spawnSync } from "node:child_process";
import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = "wasm32-unknown-unknown";
const targetInstall = spawnSync(
  "rustup",
  ["target", "add", target],
  {
    cwd: root,
    stdio: "inherit",
  },
);
if (targetInstall.error) throw targetInstall.error;
if (targetInstall.status !== 0)
  process.exit(targetInstall.status ?? 1);

const result = spawnSync(
  "cargo",
  [
    "build",
    "--target",
    target,
    "--release",
    "--locked",
    "-p",
    "stella-regex-set-wasm-single-thread",
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const targetDir = resolve(
  root,
  process.env.CARGO_TARGET_DIR ?? "target",
);
await copyFile(
  resolve(
    targetDir,
    target,
    "release/stella_regex_set_wasm_single_thread.wasm",
  ),
  resolve(root, "regex-set.single-thread.wasm"),
);
