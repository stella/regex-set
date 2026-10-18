import { library } from "@stll/oxlint-config";
import {
  portableSafetyPluginSpecifiers,
  portableSafetyRules,
} from "@stll/oxlint-plugin";
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import config from "../oxlint.config";

const root = new URL("../", import.meta.url);
const read = (path: string) =>
  readFileSync(new URL(path, root), "utf8");

describe("shared tooling adoption", () => {
  test("uses central lint defaults and every portable safety rule", () => {
    expect(config).toEqual(
      library({
        ignorePatterns: config.ignorePatterns?.filter(
          (pattern) =>
            !library().ignorePatterns?.includes(pattern),
        ),
        jsPlugins: [...portableSafetyPluginSpecifiers],
        rules: { ...portableSafetyRules },
      }),
    );
    const tsconfig = JSON.parse(read("tsconfig.json"));
    expect(tsconfig.extends).toBe(
      "@stll/typescript-config/node.json",
    );
    expect(tsconfig.compilerOptions).toEqual({
      allowImportingTsExtensions: true,
      lib: ["ESNext", "DOM"],
    });
  });

  test("generated cloud setup is reproducible without changing the hook", () => {
    const paths = [
      ".agents/cloud-setup.sh",
      ".claude/settings.json",
    ];
    const before = paths.map(read);
    execFileSync(
      "bunx",
      ["--no-install", "stll-cloud-setup"],
      {
        cwd: root,
      },
    );
    expect(paths.map(read)).toEqual(before);
    expect(read(".agents/cloud-setup.sh")).toContain(
      '"$BUN_DIR/bun" install --frozen-lockfile',
    );
    expect(read(".claude/settings.json")).toContain(
      "CLAUDE_CODE_REMOTE",
    );
  });

  test("CI uses the central detector and preserves fail-safe parity", () => {
    const workflow = read(".github/workflows/ci.yml");
    const checks = workflow
      .split("  checks:\n")
      .at(1)
      ?.split("  napi-ci:\n")
      .at(0);
    const changes = workflow
      .split("  check-changes:\n")
      .at(1)
      ?.split("  trust-check:\n")
      .at(0);
    expect(checks).toContain("fetch-depth: 0");
    expect(changes).toContain("fetch-depth: 0");
    expect(changes).toContain("persist-credentials: false");
    expect(changes).toContain(
      "bun install --frozen-lockfile --ignore-scripts",
    );
    expect(changes).toContain(
      'stll-toolchain-changed --since "$BASE_REF"',
    );
    expect(changes).toContain(
      "github.event.pull_request.base.sha",
    );
    expect(changes).toContain("github.event.before");
    expect(changes).toContain("unavailable-toolchain-base");
    for (const domain of ["rust", "build", "provenance"]) {
      expect(changes).toContain(
        `steps.filter.outputs.${domain} == 'true' || steps.toolchain.outputs.changed == 'true'`,
      );
    }
    expect(changes).not.toContain("'.github/workflows/**'");
    expect(changes).not.toContain("'rust-toolchain.toml'");
    expect(changes).toContain("'__test__/**'");
    const parsed = Bun.YAML.parse(workflow);
    expect(parsed.jobs["napi-ci"].with.typecheck).toBe(
      true,
    );
    const steps = checks?.split("      - ") ?? [];
    const toolchainStep = steps.find((step) =>
      step.startsWith("run: bun run check:toolchain\n"),
    );
    expect(toolchainStep).toContain(
      "if: needs.check-changes.outputs.toolchain-changed == 'true'",
    );
    for (const command of [
      "typecheck",
      "check:typecheck-parity",
    ]) {
      const step = steps.find((candidate) =>
        candidate.startsWith(`run: bun run ${command}\n`),
      );
      expect(step).toBeUndefined();
    }
  });

  test("runtime selectors share policy pins with one bounded Hawk exception", () => {
    const declaration = JSON.parse(
      read("stll-toolchain.json"),
    );
    expect(declaration.rustExceptions).toHaveLength(1);
    expect(declaration.rustExceptions.at(0)).toMatchObject({
      pin: "1.97.1",
      tracking:
        "https://github.com/stella/tooling/issues/99",
      expires: "2026-11-11",
    });
    expect(read(".node-version").trim()).toBe("26.10.0");
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain('node-version: "26.10.0"');
    const release = read(".github/workflows/release.yml");
    expect(
      release.match(/node-version-file: .node-version/g),
    ).toHaveLength(5);
    expect(
      release.match(/toolchain: "1.99.0"/g),
    ).toHaveLength(3);
    expect(release).not.toMatch(/node-version: "22/);
  });

  test("shared detector skips prose and detects runtime changes or missing history", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "regex toolchain-ž-"),
    );
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: directory,
        encoding: "utf8",
      }).trim();
    const detect = (since: string) =>
      JSON.parse(
        execFileSync(
          "node",
          [
            fileURLToPath(
              pathToFileURL(
                join(
                  directory,
                  "node_modules/@stll/oxlint-config/dist/toolchain-changed-cli.mjs",
                ),
              ),
            ),
            "--since",
            since,
          ],
          { cwd: directory, encoding: "utf8" },
        ),
      );
    try {
      symlinkSync(
        fileURLToPath(new URL("node_modules", root)),
        join(directory, "node_modules"),
        "dir",
      );
      git("init", "--quiet");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      git("config", "commit.gpgsign", "false");
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({ packageManager: "bun@1.4.3" }),
      );
      git("add", "package.json");
      git("commit", "--quiet", "-m", "fixture");
      const base = git("rev-parse", "HEAD");
      writeFileSync(
        join(directory, "README.md"),
        "Prose only\n",
      );
      git("add", "README.md");
      git("commit", "--quiet", "-m", "prose");
      expect(detect(base).changed).toBe(false);
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({ packageManager: "bun@1.4.4" }),
      );
      git("add", "package.json");
      git("commit", "--quiet", "-m", "runtime");
      expect(detect(base).changed).toBe(true);
      expect(
        detect("unavailable-toolchain-base"),
      ).toMatchObject({
        status: "unreadable",
        changed: true,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
