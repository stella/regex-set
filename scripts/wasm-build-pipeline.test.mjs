import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const { scripts } = JSON.parse(read("../package.json"));

test("the shared WASM build emits both artifacts before JavaScript packaging", () => {
  expect(scripts["build:wasm"]).toBe(
    "node scripts/build-single-thread.mjs && node scripts/build-native.mjs --platform --target wasm32-wasip1-threads --dts index.d.cts --release",
  );
  expect(scripts["build:js"]).toMatch(
    /^node scripts\/ensure-wasm-artifact\.mjs && .*node scripts\/pack-single-thread\.mjs$/,
  );
  const ensure = read("./ensure-wasm-artifact.mjs");
  expect(ensure).toContain(
    "await access(singleThreadPath, constants.F_OK)",
  );
  expect(ensure).toContain(
    'spawnSync("bun", ["run", "build:wasm"]',
  );
  expect(ensure).not.toContain("build-native.mjs");
});

test("the single-thread build installs its target explicitly", () => {
  const build = read("./build-single-thread.mjs");
  expect(
    build.indexOf('["target", "add", target]'),
  ).toBeGreaterThan(-1);
  expect(
    build.indexOf('["target", "add", target]'),
  ).toBeLessThan(build.indexOf('  "cargo",'));
});

test("artifact runtime tests are explicitly scheduled after packaging", () => {
  expect(scripts["test:single-thread"]).toBe(
    "bun test ./__test__/single-thread.runtime.ts",
  );
  for (const path of [
    "../.github/workflows/ci.yml",
    "../.github/workflows/release.yml",
  ]) {
    const lines = read(path).split("\n");
    const runtimeSteps = lines.flatMap((line, index) =>
      line.trim() === "- run: bun run test:single-thread"
        ? [index]
        : [],
    );
    expect(runtimeSteps.length).toBeGreaterThan(0);
    for (const index of runtimeSteps) {
      expect(lines[index - 1].trim()).toBe(
        "- run: bun run build:js",
      );
    }
  }
});
