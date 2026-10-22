import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const distEntry = path.join(repositoryRoot, "dist/index.mjs");
const distSource = await readFile(distEntry, "utf8");
// The probe must find the addon inside the executable, never through a
// loader override that points back at a file on disk.
const probeEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      name !== "NAPI_RS_NATIVE_LIBRARY_PATH" && name !== "NAPI_RS_FORCE_WASI",
  ),
);

const stagingRoot = await mkdtemp(path.join(tmpdir(), "regex-set-compiled-"));
const packageRoot = path.join(stagingRoot, "node_modules/@stll/regex-set");

try {
  await mkdir(path.join(packageRoot, "dist"), {
    recursive: true,
  });
  await Promise.all([
    copyFile(
      path.join(repositoryRoot, "package.json"),
      path.join(packageRoot, "package.json"),
    ),
    copyFile(
      path.join(repositoryRoot, "index.cjs"),
      path.join(packageRoot, "index.cjs"),
    ),
    copyFile(distEntry, path.join(packageRoot, "dist/index.mjs")),
  ]);

  let nativePackageCount = 0;
  const npmRoot = path.join(repositoryRoot, "npm");
  for (const directory of await readdir(npmRoot)) {
    const sourceRoot = path.join(npmRoot, directory);
    const packageJsonPath = path.join(sourceRoot, "package.json");
    /** @type {unknown} */
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const main =
      typeof packageJson === "object" && packageJson !== null
        ? Reflect.get(packageJson, "main")
        : undefined;
    if (typeof main !== "string" || !main.endsWith(".node")) {
      continue;
    }
    const name =
      typeof packageJson === "object" && packageJson !== null
        ? Reflect.get(packageJson, "name")
        : undefined;
    if (typeof name !== "string") {
      throw new Error(`${packageJsonPath} has no package name`);
    }

    const packagedNativePath = path.join(sourceRoot, main);
    const rootNativePath = path.join(repositoryRoot, main);
    let nativePath = packagedNativePath;
    try {
      await readFile(packagedNativePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      nativePath = rootNativePath;
      try {
        await readFile(rootNativePath);
      } catch (rootError) {
        if (rootError?.code === "ENOENT") continue;
        throw rootError;
      }
    }

    const destination = path.join(stagingRoot, "node_modules", name);
    await mkdir(destination, { recursive: true });
    await Promise.all([
      copyFile(packageJsonPath, path.join(destination, "package.json")),
      copyFile(nativePath, path.join(destination, main)),
    ]);
    nativePackageCount++;
  }
  assert.ok(nativePackageCount > 0, "no built native platform package found");

  const probePath = path.join(stagingRoot, "probe.ts");
  await writeFile(
    probePath,
    'import { RegexSet } from "@stll/regex-set";\nconsole.log(new RegexSet(["alpha", "beta"]).whichMatch("beta"));\n',
  );
  const compile = spawnSync(
    "bun",
    ["build", "--compile", "probe.ts", "--outfile", "probe"],
    {
      cwd: stagingRoot,
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  assert.ifError(compile.error);
  assert.equal(compile.status, 0, compile.stderr || compile.stdout);

  await Promise.all([
    rm(path.join(stagingRoot, "node_modules"), {
      recursive: true,
    }),
    rm(probePath),
  ]);
  const probe = spawnSync("./probe", [], {
    cwd: stagingRoot,
    encoding: "utf8",
    env: probeEnvironment,
    timeout: 30_000,
  });
  assert.ifError(probe.error);
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  assert.equal(probe.stdout, "[ 1 ]\n");

  // Checked after the boot so a regression is reported by the binary itself.
  assert.match(distSource, /import\s+[^;]+from\s*["']\.\.\/index\.cjs["']/);
  assert.doesNotMatch(distSource, /createRequire/);
} finally {
  await rm(stagingRoot, { force: true, recursive: true });
}

console.log("compiled smoke ok");
