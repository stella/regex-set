import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { normalizeGeneratedLoader } from "./generated-loader-normalization.mjs";

const cliPath = new URL(
  "../node_modules/@napi-rs/cli/dist/cli.js",
  import.meta.url,
);

const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(cliPath),
    "build",
    "--js",
    "index.cjs",
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
  },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

async function normalizeGeneratedFile(fileName) {
  const fileUrl = new URL(
    `../${fileName}`,
    import.meta.url,
  );
  try {
    let content = await readFile(fileUrl, "utf8");
    await writeFile(
      fileUrl,
      normalizeGeneratedLoader(content),
    );
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

await normalizeGeneratedFile("index.cjs");
await normalizeGeneratedFile("index.d.cts");
await normalizeGeneratedFile("regex-set.wasi.cjs");
await normalizeGeneratedFile("regex-set.wasi.d.cts");
await normalizeGeneratedFile("regex-set.wasi-browser.js");
await normalizeGeneratedFile("wasi-worker-browser.mjs");
await normalizeGeneratedFile("wasi-worker.mjs");

const declarationPath = new URL(
  "../index.d.cts",
  import.meta.url,
);
const declarationSource = await readFile(
  declarationPath,
  "utf8",
);
const defaultExportDeclaration = `
import type { NativeBinding } from "./src/core";

declare const binding: NativeBinding
export default binding
`;
if (!declarationSource.includes("export default binding")) {
  await writeFile(
    declarationPath,
    `${declarationSource.trimEnd()}\n${defaultExportDeclaration}`,
  );
}

const formatResult = spawnSync(
  "bun",
  [
    "x",
    "oxfmt",
    "index.cjs",
    "index.d.cts",
    "regex-set.wasi.cjs",
    "regex-set.wasi.d.cts",
    "regex-set.wasi-browser.js",
    "wasi-worker-browser.mjs",
    "wasi-worker.mjs",
  ],
  { stdio: "inherit" },
);

if (formatResult.status !== 0) {
  process.exit(formatResult.status ?? 1);
}

const contractResult = spawnSync(
  "bun",
  [
    fileURLToPath(
      new URL(
        "./wasi-artifact-contract.mjs",
        import.meta.url,
      ),
    ),
    "--generated",
  ],
  { stdio: "inherit" },
);

if (contractResult.status !== 0) {
  process.exit(contractResult.status ?? 1);
}
