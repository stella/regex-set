#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function repoPath(...segments) {
  return path.join(ROOT, ...segments);
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function writeText(filePath, content) {
  fs.writeFileSync(filePath, content);
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function writeJson(filePath, value) {
  writeText(
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function readVersion() {
  return readText(repoPath("VERSION")).trim();
}

function replaceRequired(
  content,
  matcher,
  replacement,
  filePath,
) {
  if (!matcher.test(content)) {
    throw new Error(
      `Expected to match ${matcher} in ${filePath}`,
    );
  }
  return content.replace(matcher, replacement);
}

function describeMismatches(
  currentVersion,
  expectedVersion,
) {
  const mismatches = [];
  const packageJsonPath = repoPath("package.json");
  const cargoTomlPath = repoPath("Cargo.toml");
  const cargoLockPath = repoPath("Cargo.lock");
  const bunLockPath = repoPath("bun.lock");
  const indexCjsPath = repoPath("index.cjs");
  const provenanceSbomPath = repoPath(
    "provenance",
    "sbom.cdx.json",
  );

  const root = readJson(packageJsonPath);
  const versionFileVersion = readVersion();
  if (versionFileVersion !== expectedVersion) {
    mismatches.push(
      `${repoPath("VERSION")}: version=${versionFileVersion}`,
    );
  }
  if (root.version !== expectedVersion) {
    mismatches.push(
      `${packageJsonPath}: version=${root.version}`,
    );
  }

  for (const [name, optionalVersion] of Object.entries(
    root.optionalDependencies ?? {},
  )) {
    if (
      name.startsWith("@stll/regex-set-") &&
      optionalVersion !== expectedVersion
    ) {
      mismatches.push(
        `${packageJsonPath}: optionalDependencies.${name}=${optionalVersion}`,
      );
    }
  }

  const wasm = readJson(repoPath("wasm", "package.json"));
  if (wasm.version !== expectedVersion) {
    mismatches.push(
      `${repoPath("wasm", "package.json")}: version=${wasm.version}`,
    );
  }

  for (const entry of fs.readdirSync(repoPath("npm"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifestPath = repoPath(
      "npm",
      entry.name,
      "package.json",
    );
    const manifest = readJson(manifestPath);
    if (manifest.version !== expectedVersion) {
      mismatches.push(
        `${manifestPath}: version=${manifest.version}`,
      );
    }
  }

  const cargoToml = readText(cargoTomlPath);
  const cargoTomlMatch = cargoToml.match(
    /^version = "([^"]+)"$/m,
  );
  if (
    !cargoTomlMatch ||
    cargoTomlMatch[1] !== expectedVersion
  ) {
    mismatches.push(
      `${cargoTomlPath}: version=${cargoTomlMatch?.[1] ?? "<missing>"}`,
    );
  }

  const cargoLock = readText(cargoLockPath);
  const cargoLockMatch = cargoLock.match(
    /\[\[package\]\]\nname = "stella-regex-set"\nversion = "([^"]+)"/,
  );
  if (
    !cargoLockMatch ||
    cargoLockMatch[1] !== expectedVersion
  ) {
    mismatches.push(
      `${cargoLockPath}: version=${cargoLockMatch?.[1] ?? "<missing>"}`,
    );
  }

  const bunLock = readText(bunLockPath);
  for (const pkg of Object.keys(
    root.optionalDependencies ?? {},
  ).filter((name) => name.startsWith("@stll/regex-set-"))) {
    const escaped = pkg.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    const match = bunLock.match(
      new RegExp(`"${escaped}": "([^"]+)"`),
    );
    if (!match || match[1] !== expectedVersion) {
      mismatches.push(
        `${bunLockPath}: ${pkg}=${match?.[1] ?? "<missing>"}`,
      );
    }
  }

  const indexCjs = readText(indexCjsPath);
  if (
    !indexCjs.includes(
      `expected ${expectedVersion} but got`,
    )
  ) {
    mismatches.push(
      `${indexCjsPath}: expected version string ${expectedVersion}`,
    );
  }

  const provenanceSbom = readText(provenanceSbomPath);
  if (
    !provenanceSbom.includes(
      `pkg:npm/@stll/regex-set@${expectedVersion}`,
    )
  ) {
    mismatches.push(
      `${provenanceSbomPath}: npm purl not updated to ${expectedVersion}`,
    );
  }
  if (
    !provenanceSbom.includes(
      `pkg:cargo/stella-regex-set@${expectedVersion}`,
    )
  ) {
    mismatches.push(
      `${provenanceSbomPath}: cargo purl not updated to ${expectedVersion}`,
    );
  }

  if (currentVersion !== expectedVersion) {
    mismatches.push(
      `package version source drift: root=${currentVersion} expected=${expectedVersion}`,
    );
  }

  return mismatches;
}

function syncVersion(nextVersion) {
  const packageJsonPath = repoPath("package.json");
  const cargoTomlPath = repoPath("Cargo.toml");
  const cargoLockPath = repoPath("Cargo.lock");
  const bunLockPath = repoPath("bun.lock");
  const indexCjsPath = repoPath("index.cjs");
  const provenanceSbomPath = repoPath(
    "provenance",
    "sbom.cdx.json",
  );

  const root = readJson(packageJsonPath);
  const previousVersion = root.version;
  writeText(repoPath("VERSION"), `${nextVersion}\n`);
  root.version = nextVersion;
  for (const name of Object.keys(
    root.optionalDependencies ?? {},
  )) {
    if (name.startsWith("@stll/regex-set-")) {
      root.optionalDependencies[name] = nextVersion;
    }
  }
  writeJson(packageJsonPath, root);

  const wasmPath = repoPath("wasm", "package.json");
  const wasmManifest = readJson(wasmPath);
  wasmManifest.version = nextVersion;
  writeJson(wasmPath, wasmManifest);

  for (const entry of fs.readdirSync(repoPath("npm"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifestPath = repoPath(
      "npm",
      entry.name,
      "package.json",
    );
    const manifest = readJson(manifestPath);
    manifest.version = nextVersion;
    writeJson(manifestPath, manifest);
  }

  let cargoToml = readText(cargoTomlPath);
  cargoToml = replaceRequired(
    cargoToml,
    /^version = "([^"]+)"$/m,
    `version = "${nextVersion}"`,
    cargoTomlPath,
  );
  writeText(cargoTomlPath, cargoToml);

  let cargoLock = readText(cargoLockPath);
  cargoLock = replaceRequired(
    cargoLock,
    /(\[\[package\]\]\nname = "stella-regex-set"\nversion = ")[^"]+(")/,
    `$1${nextVersion}$2`,
    cargoLockPath,
  );
  writeText(cargoLockPath, cargoLock);

  let bunLock = readText(bunLockPath);
  for (const pkg of Object.keys(
    root.optionalDependencies ?? {},
  ).filter((name) => name.startsWith("@stll/regex-set-"))) {
    const escaped = pkg.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    bunLock = replaceRequired(
      bunLock,
      new RegExp(`("${escaped}": ")([^"]+)(")`),
      `$1${nextVersion}$3`,
      bunLockPath,
    );
  }
  writeText(bunLockPath, bunLock);

  let indexCjs = readText(indexCjsPath);
  if (!indexCjs.includes(previousVersion)) {
    throw new Error(
      `Expected ${indexCjsPath} to contain ${previousVersion}`,
    );
  }
  indexCjs = indexCjs.replaceAll(
    previousVersion,
    nextVersion,
  );
  writeText(indexCjsPath, indexCjs);

  let provenanceSbom = readText(provenanceSbomPath);
  if (!provenanceSbom.includes(previousVersion)) {
    throw new Error(
      `Expected ${provenanceSbomPath} to contain ${previousVersion}`,
    );
  }
  provenanceSbom = provenanceSbom.replaceAll(
    previousVersion,
    nextVersion,
  );
  writeText(provenanceSbomPath, provenanceSbom);
}

function parseArgs() {
  const [command, ...rest] = process.argv.slice(2);
  const args = new Map();
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--version") {
      const value = rest[i + 1];
      if (value == null) {
        throw new Error("Missing value for --version");
      }
      args.set("version", value);
      i += 1;
      continue;
    }
    if (token === "--tag") {
      const value = rest[i + 1];
      if (value == null) {
        throw new Error("Missing value for --tag");
      }
      args.set("tag", value);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return { command, args };
}

function main() {
  const { command, args } = parseArgs();

  if (command !== "sync" && command !== "check") {
    console.error(
      "Usage: node scripts/version-sync.mjs <sync|check> [--version <semver>] [--tag <git-tag>]",
    );
    process.exit(1);
  }

  const rootVersion = readJson(
    repoPath("package.json"),
  ).version;
  const version =
    args.get("version") ??
    args.get("tag")?.replace(/^v/, "") ??
    readVersion();

  if (command === "sync") {
    syncVersion(version);
    return;
  }

  if (command === "check") {
    const mismatches = describeMismatches(
      rootVersion,
      version,
    );
    if (mismatches.length > 0) {
      console.error("Version drift detected:");
      for (const mismatch of mismatches) {
        console.error(`- ${mismatch}`);
      }
      process.exit(1);
    }
    return;
  }
}

main();
