import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const WORKFLOW_DIRECTORY = new URL(
  "../.github/workflows/",
  import.meta.url,
);
const DISALLOWED_INSTALL =
  /\b(?:npm\s+(?:ci|i|install)|pnpm\s+(?:i|install)|yarn(?:\s+install)?)\b/;
const GLOBAL_NPM_INSTALL =
  /\bnpm\s+(?:i|install)\s+(?:--global|-g)\b/;
const BUN_INSTALL = /\bbun\s+install\b/;
const FROZEN_LOCKFILE = /--frozen-lockfile\b/;

const workflowNames = (
  await readdir(WORKFLOW_DIRECTORY)
).filter((name) => /\.ya?ml$/.test(name));

const violations = [];

for (const workflowName of workflowNames) {
  const workflow = await readFile(
    new URL(workflowName, WORKFLOW_DIRECTORY),
    "utf8",
  );

  for (const [index, line] of workflow
    .split("\n")
    .entries()) {
    const usesAnotherPackageManager =
      DISALLOWED_INSTALL.test(line) &&
      !GLOBAL_NPM_INSTALL.test(line);
    const usesUnlockedBunInstall =
      BUN_INSTALL.test(line) && !FROZEN_LOCKFILE.test(line);

    if (
      !usesAnotherPackageManager &&
      !usesUnlockedBunInstall
    )
      continue;

    violations.push(
      `${join(".github/workflows", workflowName)}:${index + 1}: ${line.trim()}`,
    );
  }
}

if (violations.length === 0) process.exit(0);

console.error(
  [
    "Bun-managed workflows must use `bun install --frozen-lockfile` for repository dependencies.",
    "Global npm tool installation remains allowed.",
    ...violations,
  ].join("\n"),
);
process.exit(1);
