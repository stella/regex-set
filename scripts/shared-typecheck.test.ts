import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = (name: string) =>
  Bun.YAML.parse(
    readFileSync(
      new URL(`../.github/workflows/${name}.yml`, import.meta.url),
      "utf8",
    ),
  );

test("CI type checks with bun check in the repository job", () => {
  const ci = workflow("ci");
  // The shared workflow's type check job also runs compiler parity.
  expect(ci.jobs["napi-ci"].with.typecheck).toBeUndefined();
  const local = ci.jobs.checks.steps.map((step: { run?: string }) => step.run);
  expect(local).toContain("bun run typecheck");
  expect(local).toContain(
    "bun test scripts/tooling-adoption.test.ts scripts/shared-policy.test.ts",
  );
});
