import { describe, expect, test } from "bun:test";

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
