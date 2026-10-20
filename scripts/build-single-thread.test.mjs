import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const directory = mkdtempSync(
  join(tmpdir(), "regex-set-single-thread-"),
);
try {
  const bin = join(directory, "bin");
  mkdirSync(bin);
  mkdirSync(join(directory, "src"));
  const log = join(directory, "commands.log");
  const rustup = join(bin, "rustup");
  writeFileSync(
    rustup,
    `#!/bin/sh\nprintf 'rustup %s\\n' "$*" >> "$COMMAND_LOG"\ncase "$*" in\n  "show active-toolchain") printf '%s (overridden by environment)\\n' "$RUSTUP_TOOLCHAIN" ;;\n  "target list --installed --toolchain $RUSTUP_TOOLCHAIN") printf '%s\\n' wasm32-wasip1-threads ;;\nesac\n`,
  );
  chmodSync(rustup, 0o755);
  const cargo = join(bin, "cargo");
  writeFileSync(
    cargo,
    `#!/bin/sh\nprintf 'cargo %s\\n' "$*" >> "$COMMAND_LOG"\nmkdir -p target/wasm32-unknown-unknown/release\nprintf wasm > target/wasm32-unknown-unknown/release/stella_regex_set_wasm_single_thread.wasm\n`,
  );
  chmodSync(cargo, 0o755);

  const toolchain = "test-toolchain";
  const result = spawnSync(
    process.execPath,
    [
      new URL("./build-single-thread.mjs", import.meta.url)
        .pathname,
    ],
    {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        COMMAND_LOG: log,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        RUSTUP_TOOLCHAIN: toolchain,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    readFileSync(log, "utf8").trim().split("\n"),
    [
      "rustup show active-toolchain",
      `rustup target list --installed --toolchain ${toolchain}`,
      `rustup target add wasm32-unknown-unknown --toolchain ${toolchain}`,
      "cargo build -p stella-regex-set-wasm-single-thread --target wasm32-unknown-unknown --release --locked",
    ],
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
