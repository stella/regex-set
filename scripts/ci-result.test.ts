import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const readWorkflow = (name: string) =>
  Bun.YAML.parse(
    readFileSync(
      new URL(`../.github/workflows/${name}.yml`, import.meta.url),
      "utf8",
    ),
  );

test("aggregate CI result covers every validation job", () => {
  const workflow = readWorkflow("ci");
  const jobs = workflow.jobs;
  const aggregate = jobs["ci-result"];
  const validationJobs = Object.keys(jobs)
    .filter((name) => name !== "ci-result")
    .sort((left, right) => left.localeCompare(right));

  expect(aggregate.if).toBe("always()");
  expect(
    [...aggregate.needs].sort((left, right) => left.localeCompare(right)),
  ).toEqual(validationJobs);
});

test("CI and CLA run for merge queue checks", () => {
  for (const name of ["ci", "cla"]) {
    const workflow = readWorkflow(name);
    expect(workflow.on.merge_group).toEqual({
      types: ["checks_requested"],
    });
  }
});

test("CI runs the aggregate result policy test", () => {
  const workflow = readWorkflow("ci");
  const runsCiResultTest = Object.values(workflow.jobs).some(
    ({ steps = [] }: { steps?: Array<{ run?: unknown }> }) =>
      steps.some(
        ({ run }) =>
          typeof run === "string" && run.includes("scripts/ci-result.test.ts"),
      ),
  );

  expect(runsCiResultTest).toBe(true);
});
