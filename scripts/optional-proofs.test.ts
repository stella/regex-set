import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = (name: string) =>
  Bun.YAML.parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"));

test("optional proofs run only on demand while shared CI remains enabled", () => {
  const optional = workflow("optional-proofs");
  const ci = workflow("ci");
  expect(Object.keys(optional.on)).toEqual(["workflow_dispatch"]);
  expect(Object.keys(optional.jobs).sort()).toEqual(["contract-perf", "typecheck-parity"]);
  expect(ci.jobs["contract-perf"]).toBeUndefined();
  expect(ci.jobs["napi-ci"].uses).toContain("/rust-napi-ci.yml@");
  expect(ci.jobs.checks.steps.some((step: { run?: string }) => step.run === "bun run typecheck")).toBe(true);
  expect(ci.jobs.checks.steps.some((step: { run?: string }) => step.run === "bun run check:typecheck-parity")).toBe(false);
  expect(optional.jobs["typecheck-parity"].steps.some((step: { run?: string }) => step.run === "bun run check:typecheck-parity")).toBe(true);
  expect(optional.jobs["contract-perf"].steps.some((step: { run?: string }) => step.run === "timeout 180s bun run perf:contracts")).toBe(true);
});
