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

const replaceLast = (value, search, replacement) => {
  const index = value.lastIndexOf(search);
  expect(
    index,
    `missing mutation target: ${search}`,
  ).not.toBe(-1);
  return `${value.slice(0, index)}${replacement}${value.slice(index + search.length)}`;
};

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

  test("rejects inputs on privileged action steps", () => {
    const checkout = `      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false`;
    for (const input of [
      "repository: attacker/repository",
      "ref: attacker-controlled-ref",
    ]) {
      const mutation = replaceLast(
        workflow,
        checkout,
        `${checkout}\n          ${input}`,
      );
      expect(mutation).not.toBe(workflow);
      expect(() =>
        checkReleasePrivilegeBoundary(mutation),
      ).toThrow(
        /core privileged (run-)?step allowlist changed/,
      );
    }
  });

  test("rejects execution controls on privileged run steps", () => {
    const publishStep = `      - name: Publish Rust core
        if: steps.crate-status.outputs.already-released != 'true'
        working-directory: \${{ runner.temp }}
        run: |
          set -euo pipefail
          mkdir -p "$CARGO_HOME"
          cargo publish \\
            --manifest-path "$GITHUB_WORKSPACE/crates/core/Cargo.toml" \\
            --locked \\
            --no-verify
        env:
          # Keep repository-controlled Cargo configuration outside the credential path.
          CARGO_HOME: \${{ runner.temp }}/release-cargo-home
          CARGO_REGISTRY_TOKEN: \${{ steps.crates-io-auth.outputs.token }}`;
    for (const mutationStep of [
      publishStep.replace(
        "        run:",
        "        shell: bash -c 'echo malicious; {0}'\n        run:",
      ),
      `${publishStep}\n          MALICIOUS_ENV: enabled`,
      publishStep.replace(
        "if: steps.crate-status.outputs.already-released != 'true'",
        "if: always()",
      ),
    ]) {
      const mutation = workflow.replace(
        publishStep,
        mutationStep,
      );
      expect(mutation).not.toBe(workflow);
      expect(() =>
        checkReleasePrivilegeBoundary(mutation),
      ).toThrow("core privileged step allowlist changed");
    }
  });

  test("rejects repository-scoped Cargo configuration", () => {
    for (const [search, replacement] of [
      [
        "        working-directory: ${{ runner.temp }}",
        "        working-directory: .",
      ],
      [
        "          CARGO_HOME: ${{ runner.temp }}/release-cargo-home",
        "          CARGO_HOME: ${{ github.workspace }}/.cargo",
      ],
    ]) {
      const mutation = replaceLast(
        workflow,
        search,
        replacement,
      );
      expect(() =>
        checkReleasePrivilegeBoundary(mutation),
      ).toThrow(
        /core privileged (run-)?step allowlist changed|isolate Cargo configuration/,
      );
    }
  });

  test("rejects every unexpected write permission owner", () => {
    for (const [permission, access] of [
      ["contents", "write"],
      ["packages", "write"],
      ["actions", "write"],
    ]) {
      const mutation = workflow
        .replace(
          `  pack:
    name: Pack`,
          `  pack:
    name: Pack`,
        )
        .replace(
          `  pack:
    name: Pack
    needs: [preflight, verify, test]
    if: needs.preflight.outputs.already-released != 'true'
    runs-on: ubuntu-latest
    permissions:
      contents: read`,
          `  pack:
    name: Pack
    needs: [preflight, verify, test]
    if: needs.preflight.outputs.already-released != 'true'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      ${permission}: ${access}`,
        );
      expect(mutation).not.toBe(workflow);
      expect(() =>
        checkReleasePrivilegeBoundary(mutation),
      ).toThrow(
        "release write-permission allowlist changed",
      );
    }
  });

  test("rejects inherited workflow execution controls", () => {
    for (const mutation of [
      workflow.replace(
        "\npermissions:\n",
        "\ndefaults:\n  run:\n    shell: bash -c 'echo malicious; {0}'\n\npermissions:\n",
      ),
      workflow.replace(
        "env:\n  NODE_VERSION:",
        "env:\n  PRELOAD_COMMAND: malicious\n  NODE_VERSION:",
      ),
    ]) {
      expect(mutation).not.toBe(workflow);
      expect(() =>
        checkReleasePrivilegeBoundary(mutation),
      ).toThrow("release workflow scope changed");
    }
  });

  test("rejects secret access outside the exact finalizer mapping", () => {
    for (const mutation of [
      workflow.replace(
        "  pack:\n    name: Pack",
        "  pack:\n    env:\n      RELEASE_TOKEN: ${{ secrets.NPM_TOKEN }}\n    name: Pack",
      ),
      workflow.replace(
        "  pack:\n    name: Pack",
        "  pack:\n    env:\n      RELEASE_TOKEN: ${{ secrets [ 'NPM_TOKEN' ] }}\n    name: Pack",
      ),
      workflow.replace(
        "  preflight:\n    name: Preflight",
        "  preflight:\n    name: Preflight\n    secrets: inherit",
      ),
    ]) {
      expect(mutation).not.toBe(workflow);
      expect(() =>
        checkReleasePrivilegeBoundary(mutation),
      ).toThrow("release secret allowlist changed");
    }
  });

  test("accepts the reviewed workflow as a fixed point", () => {
    checkReleasePrivilegeBoundary(workflow);
    expect(
      parseJobBodies(workflow).jobBodies.size,
    ).toBeGreaterThan(0);
  });
});
