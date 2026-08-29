import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  checkReleasePrivilegeBoundary,
  parseJobBodies,
} from "./check-release-privilege-boundary.mjs";

const workflow = readFileSync(
  new URL(
    "../.github/workflows/release.yml",
    import.meta.url,
  ),
  "utf8",
);

describe("release privilege boundary", () => {
  test("recognizes the complete GitHub job identifier grammar", () => {
    const fixture = `
jobs:
  a:
    runs-on: ubuntu-latest
  _:
    runs-on: ubuntu-latest
  publish_npm:
    runs-on: ubuntu-latest
  Publish-1:
    runs-on: ubuntu-latest
  'quoted_id':
    runs-on: ubuntu-latest
  "Q":
    runs-on: ubuntu-latest
`;

    expect([
      ...parseJobBodies(fixture).jobBodies.keys(),
    ]).toEqual([
      "a",
      "_",
      "publish_npm",
      "Publish-1",
      "quoted_id",
      "Q",
    ]);
  });

  test("rejects every valid spelling of an unexpected OIDC job", () => {
    for (const job of [
      "x",
      "_",
      "publish_npm",
      "Publish-1",
    ]) {
      const mutation = `${workflow}
  ${job}:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    steps:
      - run: make
`;
      expect(() =>
        checkReleasePrivilegeBoundary(mutation),
      ).toThrow("release OIDC job allowlist changed");
    }
  });

  test("rejects arbitrary privileged shell steps", () => {
    for (const command of [
      "bash scripts/arbitrary.sh",
      "make",
      "cargo run --bin arbitrary",
    ]) {
      const mutation = workflow.replace(
        "\n  finalize:",
        `
      - name: Unreviewed privileged command
        run: ${command}

  finalize:`,
      );
      expect(mutation).not.toBe(workflow);
      expect(() =>
        checkReleasePrivilegeBoundary(mutation),
      ).toThrow(
        "core privileged run-step allowlist changed",
      );
    }
  });

  test("accepts the reviewed workflow as a fixed point", () => {
    checkReleasePrivilegeBoundary(workflow);
    expect(
      parseJobBodies(workflow).jobBodies.size,
    ).toBeGreaterThan(0);
  });
});
