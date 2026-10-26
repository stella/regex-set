import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { library } from "@stll/oxlint-config";
import {
  portableSafetyPluginSpecifiers,
  portableSafetyRules,
} from "@stll/oxlint-plugin";

import config from "../oxlint.config";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

const expandPackageScripts = (
  command: string,
  scripts: Record<string, string>,
  resolving = new Set<string>(),
): string =>
  command.replace(
    /\b(?:bun|npm|pnpm|yarn) run ([\w:-]+)/gu,
    (invocation, name: string) => {
      const script = scripts[name];
      if (script === undefined || resolving.has(name)) {
        return invocation;
      }
      return `${invocation} ${expandPackageScripts(
        script,
        scripts,
        new Set([...resolving, name]),
      )}`;
    },
  );

const singleThreadArtifactOrderingViolations = (
  workflows: Record<string, string>,
  scripts: Record<string, string>,
) => {
  const violations: string[] = [];
  for (const [path, source] of Object.entries(workflows)) {
    const jobs = Bun.YAML.parse(source).jobs ?? {};
    for (const [jobName, job] of Object.entries<{
      steps?: { run?: unknown }[];
    }>(jobs)) {
      let artifactBuilt = false;
      for (const [index, step] of (job.steps ?? []).entries()) {
        if (typeof step.run !== "string") continue;
        const command = expandPackageScripts(step.run, scripts);
        const consumesArtifact =
          command.includes("test:single-thread") ||
          /\b(?:bun|npm|pnpm|yarn)\s+(?:pack|publish)\b/u.test(command);
        if (consumesArtifact && !artifactBuilt) {
          violations.push(`${path}:${jobName}:step ${index + 1}`);
        }
        if (command.includes("build-single-thread.mjs")) {
          artifactBuilt = true;
        }
      }
    }
  }
  return violations;
};

describe("shared tooling adoption", () => {
  test("uses central lint defaults and every portable safety rule", () => {
    expect(config).toEqual(
      library({
        ignorePatterns: config.ignorePatterns?.filter(
          (pattern) => !library().ignorePatterns?.includes(pattern),
        ),
        jsPlugins: [...portableSafetyPluginSpecifiers],
        rules: { ...portableSafetyRules },
      }),
    );
    const tsconfig = JSON.parse(read("tsconfig.json"));
    expect(tsconfig.extends).toBe("@stll/typescript-config/node.json");
    expect(tsconfig.compilerOptions).toEqual({
      allowImportingTsExtensions: true,
    });
  });

  test("generated cloud setup is reproducible without changing the hook", () => {
    const paths = [".agents/cloud-setup.sh", ".claude/settings.json"];
    const before = paths.map(read);
    execFileSync("bunx", ["--no-install", "stll-cloud-setup"], {
      cwd: root,
    });
    expect(paths.map(read)).toEqual(before);
    expect(read(".agents/cloud-setup.sh")).toContain(
      '"$BUN_DIR/bun" install --frozen-lockfile',
    );
    expect(read(".claude/settings.json")).toContain("CLAUDE_CODE_REMOTE");
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
    expect(changes).toContain("bun install --frozen-lockfile --ignore-scripts");
    expect(changes).toContain('stll-toolchain-changed --since "$BASE_REF"');
    expect(changes).toContain("github.event.pull_request.base.sha");
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
    expect(parsed.jobs["napi-ci"].with.typecheck).toBe(true);
    const steps = checks?.split("      - ") ?? [];
    const toolchainStep = steps.find((step) =>
      step.startsWith("run: bun run check:toolchain\n"),
    );
    expect(toolchainStep).toContain(
      "if: needs.check-changes.outputs.toolchain-changed == 'true'",
    );
    for (const command of ["typecheck", "check:typecheck-parity"]) {
      const step = steps.find((candidate) =>
        candidate.startsWith(`run: bun run ${command}\n`),
      );
      expect(step).toBeUndefined();
    }
  });

  test("CI and release verify the real single-thread artifact", () => {
    const ci = read(".github/workflows/ci.yml");
    const parsedCi = Bun.YAML.parse(ci);
    const singleThread = parsedCi.jobs["single-thread"];
    expect(singleThread.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ run: "bun run build" }),
        expect.objectContaining({
          run: "bun run build:js",
        }),
        expect.objectContaining({
          run: "bun run build:single-thread-package",
        }),
        expect.objectContaining({
          run: "bun run test:single-thread",
        }),
      ]),
    );
    expect(parsedCi.jobs.checks.steps).toContainEqual({
      run: "node scripts/build-single-thread.test.mjs",
    });
    const singleThreadToolchain = singleThread.steps.find(
      (step: Record<string, unknown>) =>
        typeof step.uses === "string" &&
        step.uses.startsWith("dtolnay/rust-toolchain@"),
    );
    expect(singleThreadToolchain.with).toMatchObject({
      toolchain: "1.99.0",
      targets: "wasm32-wasip1-threads, wasm32-unknown-unknown",
    });
    expect(parsedCi.jobs["ci-result"].needs).toContain("single-thread");
    expect(ci).toContain('test "$SINGLE_THREAD_RESULT" = success');

    const release = read(".github/workflows/release.yml");
    const parsedRelease = Bun.YAML.parse(release);
    for (const jobName of ["verify", "pack"]) {
      const toolchain = parsedRelease.jobs[jobName].steps.find(
        (step: Record<string, unknown>) =>
          typeof step.uses === "string" &&
          step.uses.startsWith("dtolnay/rust-toolchain@"),
      );
      expect(toolchain.with.toolchain).toBe("1.99.0");
      expect(toolchain.with.targets.split(/,\s*/)).toContain(
        "wasm32-unknown-unknown",
      );
    }
    const scripts = Object.fromEntries(
      Object.entries(JSON.parse(read("package.json")).scripts).map(
        ([name, command]) => {
          expect(typeof command).toBe("string");
          return [name, String(command)];
        },
      ),
    );
    expect(scripts.build).not.toContain("build:package");
    expect(scripts["build:js"]).not.toContain("build:package");
    expect(scripts["build:single-thread-package"]).toContain(
      "build-single-thread.mjs",
    );
    expect(scripts["build:package"]).toContain("build:single-thread-package");
    const workflowDirectory = new URL(".github/workflows/", root);
    const workflows = Object.fromEntries(
      readdirSync(workflowDirectory)
        .filter((path) => /\.ya?ml$/u.test(path))
        .map((path) => [path, read(`.github/workflows/${path}`)]),
    );
    expect(singleThreadArtifactOrderingViolations(workflows, scripts)).toEqual(
      [],
    );
    expect(
      singleThreadArtifactOrderingViolations(
        {
          "negative.yml": `jobs:\n  unsafe:\n    steps:\n      - run: bun run build:js\n      - run: bun run test:single-thread\n`,
        },
        scripts,
      ),
    ).toEqual(["negative.yml:unsafe:step 2"]);

    const napiCommands = Object.entries(parsedCi.jobs["napi-ci"].with)
      .filter(
        ([name, value]) =>
          name.endsWith("-command") && typeof value === "string",
      )
      .map(([, value]) => value as string);
    const sharedScripts = [
      "build",
      "build:js",
      "test",
      "test:props",
      "test:runtime:bun",
      "test:runtime:node",
    ];
    const pending = [
      ...napiCommands,
      ...sharedScripts.map((name) => scripts[name]),
    ];
    const resolved = new Set<string>();
    while (pending.length > 0) {
      const command = pending.pop();
      if (!command || resolved.has(command)) continue;
      resolved.add(command);
      for (const match of command.matchAll(/bun run ([\w:-]+)/g)) {
        const dependency = scripts[match[1]];
        if (typeof dependency === "string") {
          pending.push(dependency);
        }
      }
    }
    expect([...resolved].join("\n")).not.toContain("build-single-thread.mjs");
    expect(scripts["test:single-thread"]).toBe(
      "bun --config=bunfig.single-thread.toml test",
    );
    expect(scripts.test).not.toContain("single-thread");
    expect(read("bunfig.toml")).toContain(
      'pathIgnorePatterns = ["single-thread-test"]',
    );
    expect(read("bunfig.single-thread.toml")).toContain(
      'root = "./single-thread-test"',
    );
  });

  test("runtime selectors share policy pins with one bounded Hawk exception", () => {
    const declaration = JSON.parse(read("stll-toolchain.json"));
    expect(declaration.rustExceptions).toHaveLength(1);
    expect(declaration.rustExceptions.at(0)).toMatchObject({
      pin: "1.97.1",
      tracking: "https://github.com/stella/tooling/issues/99",
      expires: "2026-11-11",
    });
    expect(read(".node-version").trim()).toBe("26.10.0");
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain('node-version: "26.10.0"');
    const release = read(".github/workflows/release.yml");
    expect(release.match(/node-version-file: .node-version/g)).toHaveLength(4);
    expect(release.match(/toolchain: "1.99.0"/g)).toHaveLength(4);
    expect(release).not.toMatch(/node-version: "22/);
  });

  test("shared detector skips prose and detects runtime changes or missing history", () => {
    const directory = mkdtempSync(join(tmpdir(), "regex toolchain-ž-"));
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
      writeFileSync(join(directory, "README.md"), "Prose only\n");
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
      expect(detect("unavailable-toolchain-base")).toMatchObject({
        status: "unreadable",
        changed: true,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
