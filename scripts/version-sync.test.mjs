import { describe, expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  replaceLoaderVersion,
  resolveVersion,
} from "./version-sync.mjs";

describe("Changesets version synchronization", () => {
  test("sync follows the package version while checks follow VERSION", () => {
    const versions = {
      explicitVersion: undefined,
      packageVersion: "1.0.6",
      tag: undefined,
      versionFileVersion: "1.0.5",
    };

    expect(
      resolveVersion({ command: "sync", ...versions }),
    ).toBe("1.0.6");
    expect(
      resolveVersion({ command: "check", ...versions }),
    ).toBe("1.0.5");
  });

  test("updates the generated loader from VERSION to the package version", () => {
    const content =
      "bindingPackageVersion !== '1.0.5'; expected 1.0.5 but got";

    expect(
      replaceLoaderVersion({
        content,
        filePath: "index.cjs",
        sourceVersion: "1.0.5",
        targetVersion: "1.0.6",
      }),
    ).toBe(
      "bindingPackageVersion !== '1.0.6'; expected 1.0.6 but got",
    );
  });
});

test("version check traverses a CycloneDX SBOM without package-manifest fields", async () => {
  const root = await realpath(
    await mkdtemp(
      path.join(tmpdir(), "version-provenance-"),
    ),
  );
  const version = "1.0.4";
  const packageName = "@stll/regex-set";
  /** @param {string} relative
   * @param {string} content */
  const write = async (relative, content) => {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  try {
    await mkdir(path.join(root, "scripts"));
    await mkdir(path.join(root, "npm"));
    for (const file of [
      "version-sync.mjs",
      "release-script-inputs.mjs",
    ])
      await copyFile(
        new URL(file, import.meta.url),
        path.join(root, "scripts", file),
      );
    await write("VERSION", `${version}\n`);
    await write(
      "package.json",
      JSON.stringify({ name: packageName, version }),
    );
    await write(
      "wasm/package.json",
      JSON.stringify({
        name: `${packageName}-wasm`,
        version,
      }),
    );
    await write(
      "Cargo.toml",
      `[package]\nname = "fixture-native"\nversion = "${version}"\npublish = false\n`,
    );
    await write(
      "crates/core/Cargo.toml",
      `[package]\nname = "fixture-core"\nversion = "${version}"\npublish = ["crates-io"]\n`,
    );
    await write("crates/core/LICENSE", "Fixture license\n");
    await write("crates/core/README.md", "Fixture crate\n");
    await write(
      "Cargo.lock",
      ["fixture-native", "fixture-core"]
        .map(
          (name) =>
            `[[package]]\nname = "${name}"\nversion = "${version}"\n`,
        )
        .join("\n"),
    );
    await write("bun.lock", "{}\n");
    const components = [
      {
        type: "library",
        name: packageName,
        version,
        purl: `pkg:npm/${packageName}@${version}`,
      },
      ...["fixture-native", "fixture-core"].map((name) => ({
        type: "library",
        name,
        version,
        purl: `pkg:cargo/${name}@${version}`,
      })),
    ];
    const sbom = {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      components,
    };
    await write(
      "provenance/sbom.cdx.json",
      JSON.stringify(sbom),
    );
    const run = () =>
      Bun.spawnSync(
        [
          "node",
          path.join(root, "scripts/version-sync.mjs"),
          "check",
        ],
        { cwd: root },
      );
    const valid = run();
    expect(valid.stderr.toString()).toBe("");
    expect(valid.exitCode).toBe(0);
    for (const component of components)
      component.version = "0.0.0";
    await write(
      "provenance/sbom.cdx.json",
      JSON.stringify(sbom),
    );
    const drift = run();
    expect(drift.exitCode).toBe(1);
    expect(drift.stderr.toString()).toContain(
      "sbom.cdx.json: pkg:cargo/fixture-core@1.0.4: version=0.0.0",
    );
    expect(drift.stderr.toString()).not.toContain(
      "Release manifest requires",
    );
    const malformed = {
      ...sbom,
      components: components.map(
        ({ version: _version, ...metadata }) =>
          Object.assign(metadata, {
            version: { unexpected: true },
          }),
      ),
    };
    await write(
      "provenance/sbom.cdx.json",
      JSON.stringify(malformed),
    );
    const malformedResult = run();
    expect(malformedResult.exitCode).toBe(1);
    expect(malformedResult.stderr.toString()).toContain(
      'version={"unexpected":true}',
    );
    expect(malformedResult.stderr.toString()).not.toContain(
      "[object Object]",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
