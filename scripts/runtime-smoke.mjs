import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdtemp,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RegexSet } from "../dist/index.mjs";

const rs = new RegexSet([
  "\\d{2}\\.\\d{2}\\.\\d{4}",
  "\\+?\\d{9,12}",
  "[A-Z]{2}\\d{6}",
  {
    pattern: "(?<!\\p{L})IČO:\\s*[0-9]{8}",
    name: "company-id",
  },
]);

const haystack =
  "Born 15.03.1990, phone +420123456789, ID CZ123456, IČO: 12345678";

const matches = rs.findIter(haystack);

assert.equal(rs.patternCount, 4);
assert.equal(rs.isMatch(haystack), true);
assert.deepEqual(rs.whichMatch(haystack), [0, 1, 2, 3]);
assert.deepEqual(
  matches.map((m) => m.text),
  [
    "15.03.1990",
    "+420123456789",
    "CZ123456",
    "IČO: 12345678",
  ],
);
assert.equal(matches[3]?.name, "company-id");

const replaced = rs.replaceAll(haystack, [
  "[DATE]",
  "[PHONE]",
  "[ID]",
  "[COMPANY]",
]);
assert.equal(
  replaced,
  "Born [DATE], phone [PHONE], ID [ID], [COMPANY]",
);

const repositoryRoot = fileURLToPath(
  new URL("../", import.meta.url),
);
const isolatedRoot = await mkdtemp(
  path.join(tmpdir(), "regex-set-loader-"),
);

function runLoaderProbe({ env, expectedError }) {
  const loaderPath = path.join(isolatedRoot, "index.cjs");
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      "try { const binding = require(process.argv[1]); if (typeof binding.RegexSet !== 'function') process.exit(2) } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1) }",
      loaderPath,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
  );
  if (expectedError) {
    assert.notEqual(probe.status, 0);
    assert.match(probe.stderr, expectedError);
    return;
  }
  assert.equal(probe.status, 0, probe.stderr);
}

try {
  await copyFile(
    path.join(repositoryRoot, "index.cjs"),
    path.join(isolatedRoot, "index.cjs"),
  );
  for (const fileName of await readdir(repositoryRoot)) {
    if (fileName.endsWith(".node")) {
      await copyFile(
        path.join(repositoryRoot, fileName),
        path.join(isolatedRoot, fileName),
      );
    }
  }

  runLoaderProbe({ env: { NAPI_RS_FORCE_WASI: "false" } });
  runLoaderProbe({ env: { NAPI_RS_FORCE_WASI: "true" } });
  runLoaderProbe({
    env: { NAPI_RS_FORCE_WASI: "error" },
    expectedError:
      /WASI binding not found and NAPI_RS_FORCE_WASI is set to error/,
  });
  runLoaderProbe({
    env: { NAPI_RS_WASI_FLAVOR: "unsupported" },
    expectedError: /Unsupported WASI flavor "unsupported"/,
  });
  runLoaderProbe({
    env: { NAPI_RS_WASI_FLAVOR: "wasm32-wasi" },
    expectedError:
      /WASI binding for flavor "wasm32-wasi" not found/,
  });
} finally {
  await rm(isolatedRoot, { force: true, recursive: true });
}

console.log("runtime smoke ok");
