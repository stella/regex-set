import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const workflow = (name: string) =>
  Bun.YAML.parse(
    readFileSync(
      new URL(`../.github/workflows/${name}.yml`, import.meta.url),
      "utf8",
    ),
  );

test("CI shares typecheck without duplicate local compiler runs", () => {
  const ci = workflow("ci");
  expect(ci.jobs["napi-ci"].with.typecheck).toBe(true);
  expect(ci.jobs["napi-ci"].with).not.toHaveProperty("typecheck-only");
  expect(ci.jobs["napi-ci"].with).not.toHaveProperty("parity");
  expect(
    existsSync(
      new URL("../.github/workflows/typecheck-nightly.yml", import.meta.url),
    ),
  ).toBe(false);
  const local = ci.jobs.checks.steps.map((step: { run?: string }) => step.run);
  expect(local).not.toContain("bun run typecheck");
  expect(local).not.toContain("bun run check:typecheck-parity");
  expect(local).toContain(
    "bun test scripts/tooling-adoption.test.ts scripts/shared-policy.test.ts",
  );
});
