#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const wasmArtifact = join(root, "regex-set.single-thread.wasm");
const wasmDist = join(root, "wasm", "dist");
const packDirectory = mkdtempSync(join(tmpdir(), "regex-set-clean-package-"));

rmSync(wasmArtifact, { force: true });
rmSync(wasmDist, { force: true, recursive: true });

try {
  execFileSync("bun", ["run", "build:package"], {
    cwd: root,
    stdio: "inherit",
  });
  const packResult = execFileSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory],
    { cwd: join(root, "wasm"), encoding: "utf8" },
  );
  const [{ filename }] = JSON.parse(packResult);
  const tarball = join(packDirectory, filename);
  const entries = new Set(
    execFileSync("tar", ["-tzf", tarball], {
      encoding: "utf8",
    })
      .trim()
      .split("\n"),
  );
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOf", tarball, "package/package.json"], {
      encoding: "utf8",
    }),
  );
  const expectedEntries = [
    "package/dist/regex-set.single-thread.wasm",
    "package/dist/single-thread.d.mts",
    "package/dist/single-thread.mjs",
    "package/dist/single-thread-inline.d.mts",
    "package/dist/single-thread-inline.mjs",
  ];
  for (const entry of expectedEntries) {
    if (!entries.has(entry)) {
      throw new Error(`Packed WASM package omits ${entry}`);
    }
  }
  for (const exportName of [
    "./single-thread",
    "./single-thread/inline",
    "./single-thread/wasm",
  ]) {
    if (manifest.exports?.[exportName] === undefined) {
      throw new Error(`Packed WASM package omits export ${exportName}`);
    }
  }
  if (readFileSync(wasmArtifact).length === 0) {
    throw new Error("Single-thread WASM artifact is empty");
  }
} finally {
  rmSync(packDirectory, { force: true, recursive: true });
}
