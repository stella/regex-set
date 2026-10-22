import { YAML } from "bun";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  parseReleaseManifest,
  readWasiPackage,
  readWasiRootEntry,
  readWasiWorkflow,
} from "./release-script-inputs.mjs";

void test("release schemas accept the actual package and workflow while preserving unrelated metadata", () => {
  const text = readFileSync(
    new URL("../package.json", import.meta.url),
    "utf8",
  );
  const manifest = parseReleaseManifest(text);
  assert.deepEqual(manifest, JSON.parse(text));
  const { targets } = readWasiPackage(manifest);
  const workflow = readWasiWorkflow(
    YAML.parse(
      readFileSync(
        new URL("../.github/workflows/release.yml", import.meta.url),
        "utf8",
      ),
    ),
  );
  assert.deepEqual(
    workflow.targets
      .map(({ target }) => target)
      .toSorted((left, right) => left.localeCompare(right)),
    targets.toSorted((left, right) => left.localeCompare(right)),
  );
  assert.equal(
    workflow.uploads.find(({ name }) => name === "Upload native binding")?.path,
    "${{ matrix.settings.node_artifact }}",
  );
  for (const rootEntry of [null, "", "regex-set.wasi-browser.js"])
    assert.equal(readWasiRootEntry({ rootEntry }), rootEntry);
});

void test("release manifests reject invalid consumed package fields", () => {
  const valid = {
    name: "@stll/regex-set",
    version: "1.0.4",
    optionalDependencies: {
      "@stll/regex-set-linux-x64-gnu": "1.0.4",
    },
    license: "MIT",
  };
  assert.deepEqual(parseReleaseManifest(JSON.stringify(valid)), valid);
  for (const value of [
    null,
    [],
    {},
    { ...valid, name: false },
    { ...valid, version: 1 },
    { ...valid, optionalDependencies: [] },
    { ...valid, optionalDependencies: { broken: null } },
  ])
    assert.throws(() => parseReleaseManifest(JSON.stringify(value)), TypeError);
});

void test("WASI metadata boundaries reject malformed containers and consumed leaves", () => {
  for (const value of [null, [], {}, { rootEntry: false }])
    assert.throws(() => readWasiRootEntry(value), TypeError);
  for (const value of [
    null,
    {},
    { napi: {}, scripts: {} },
    { napi: { targets: [1] }, scripts: {} },
  ])
    assert.throws(() => readWasiPackage(value), TypeError);
  for (const build of [
    null,
    {},
    {
      strategy: { matrix: { settings: [null] } },
      steps: [],
    },
    {
      strategy: {
        matrix: {
          settings: [{ target: "x86_64-unknown-linux-gnu" }],
        },
      },
      steps: [],
    },
    {
      strategy: { matrix: { settings: [] } },
      steps: [null],
    },
  ])
    assert.throws(() => readWasiWorkflow({ jobs: { build } }), TypeError);
});
