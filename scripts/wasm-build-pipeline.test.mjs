import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

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
});

// The executable fixture uses a POSIX shebang; it never invokes the real build.
test.skipIf(process.platform === "win32").each([
  { singleThreadPresent: true, builds: false },
  { singleThreadPresent: false, builds: true },
])(
  "artifact readiness with single-thread present=$singleThreadPresent",
  ({ singleThreadPresent, builds }) => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "regex-wasm-pipeline-")),
    );
    try {
      const scriptsDir = join(root, "scripts");
      const bin = join(root, "bin");
      mkdirSync(scriptsDir);
      mkdirSync(bin);
      copyFileSync(
        new URL(
          "./ensure-wasm-artifact.mjs",
          import.meta.url,
        ),
        join(scriptsDir, "ensure-wasm-artifact.mjs"),
      );
      writeFileSync(
        join(root, "regex-set.wasm32-wasi.wasm"),
        "threaded",
      );
      writeFileSync(
        join(root, "regex-set.wasi-browser.js"),
        "browser loader",
      );
      if (singleThreadPresent) {
        writeFileSync(
          join(root, "regex-set.single-thread.wasm"),
          "single-thread",
        );
      }
      const marker = join(root, "build-call.json");
      writeFileSync(
        join(bin, "bun"),
        `#!${process.execPath}
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.WASM_BUILD_MARKER, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
`,
        { mode: 0o755 },
      );
      const result = spawnSync(
        process.execPath,
        [join(scriptsDir, "ensure-wasm-artifact.mjs")],
        {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
            WASM_BUILD_MARKER: marker,
          },
          encoding: "utf8",
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(existsSync(marker)).toBe(builds);
      if (builds) {
        expect(
          JSON.parse(readFileSync(marker, "utf8")),
        ).toEqual({
          args: ["run", "build:wasm"],
          cwd: root,
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

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

test("changeset policy covers every workspace crate source and manifest", () => {
  const workflow = Bun.YAML.parse(
    read("../.github/workflows/ci.yml"),
  );
  const policy = workflow.jobs.changeset.steps.find(
    (step) => step.uses?.includes("/changeset-policy@"),
  );
  const globs = (name) =>
    policy.with[name]
      .trim()
      .split(/\s+/u)
      .map((pattern) => new Bun.Glob(pattern));
  const release = globs("release-paths");
  const generated = globs("generated-paths");
  const root = fileURLToPath(new URL("../", import.meta.url));
  for (const pattern of [
    "crates/*/src/**/*.rs",
    "crates/*/Cargo.toml",
  ]) {
    const paths = [
      ...new Bun.Glob(pattern).scanSync({ cwd: root }),
    ];
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(
        release.some((glob) => glob.match(path)),
        path,
      ).toBe(true);
      if (path.endsWith("/Cargo.toml"))
        expect(
          generated.some((glob) => glob.match(path)),
          path,
        ).toBe(true);
    }
  }
});
