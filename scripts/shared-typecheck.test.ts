import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import { at, list, mapping } from "./structured";

const workflow = (name: string): unknown =>
  Bun.YAML.parse(
    readFileSync(
      new URL(`../.github/workflows/${name}.yml`, import.meta.url),
      "utf8",
    ),
  );

test("CI shares typecheck without duplicate local compiler runs", () => {
  const ci = workflow("ci");
  const napiInputs = mapping(
    at(ci, "jobs", "napi-ci", "with"),
    "jobs.napi-ci.with",
  );
  expect(napiInputs["typecheck"]).toBe(true);
  expect(napiInputs).not.toHaveProperty("typecheck-only");
  expect(napiInputs).not.toHaveProperty("parity");
  expect(
    existsSync(
      new URL("../.github/workflows/typecheck-nightly.yml", import.meta.url),
    ),
  ).toBe(false);
  const local = list(
    at(ci, "jobs", "checks", "steps"),
    "jobs.checks.steps",
  ).map((step) => at(step, "run"));
  expect(local).not.toContain("bun run typecheck");
  expect(local).not.toContain("bun run check:typecheck-parity");
  expect(local).toContain(
    "bun test scripts/tooling-adoption.test.ts scripts/shared-policy.test.ts",
  );
});
