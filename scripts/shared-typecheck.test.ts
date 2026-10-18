import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = (name: string) =>
  Bun.YAML.parse(
    readFileSync(
      new URL(
        `../.github/workflows/${name}.yml`,
        import.meta.url,
      ),
      "utf8",
    ),
  );

test("CI and nightly share typecheck without duplicate local compiler runs", () => {
  const ci = workflow("ci");
  const nightly = workflow("typecheck-nightly");
  expect(ci.jobs["napi-ci"].with.typecheck).toBe(true);
  expect(nightly.jobs["napi-ci"].uses).toBe(
    ci.jobs["napi-ci"].uses,
  );
  expect(nightly.jobs["napi-ci"].with).toMatchObject({
    trusted: "true",
    typecheck: true,
    "typecheck-only": true,
    parity: "always",
  });
  expect(nightly.on.schedule).toHaveLength(1);
  expect(nightly.on).toHaveProperty("workflow_dispatch");
  const local = ci.jobs.checks.steps.map(
    (step: { run?: string }) => step.run,
  );
  expect(local).not.toContain("bun run typecheck");
  expect(local).not.toContain(
    "bun run check:typecheck-parity",
  );
  expect(local).toContain(
    "bun test scripts/tooling-adoption.test.ts scripts/shared-policy.test.ts",
  );
});
