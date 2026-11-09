import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { at, list, mapping, text } from "./structured";

const readWorkflow = (name: string): unknown =>
  Bun.YAML.parse(
    readFileSync(
      new URL(`../.github/workflows/${name}.yml`, import.meta.url),
      "utf8",
    ),
  );

test("aggregate CI result covers every validation job", () => {
  const workflow = readWorkflow("ci");
  const jobs = mapping(at(workflow, "jobs"), "jobs");
  const validationJobs = Object.keys(jobs)
    .filter((name) => name !== "ci-result")
    .sort((left, right) => left.localeCompare(right));

  expect(at(jobs, "ci-result", "if")).toBe("always()");
  expect(
    list(at(jobs, "ci-result", "needs"), "ci-result.needs")
      .map((item) => text(item, "ci-result.needs"))
      .sort((left, right) => left.localeCompare(right)),
  ).toEqual(validationJobs);
});

test("CI and CLA run for merge queue checks", () => {
  for (const name of ["ci", "cla"]) {
    const workflow = readWorkflow(name);
    expect(at(workflow, "on", "merge_group")).toEqual({
      types: ["checks_requested"],
    });
  }
});

test("CI runs the aggregate result policy test", () => {
  const workflow = readWorkflow("ci");
  const jobs = mapping(at(workflow, "jobs"), "jobs");
  const runsCiResultTest = Object.keys(jobs).some((job) => {
    const steps =
      at(jobs, job, "steps") === undefined
        ? []
        : list(at(jobs, job, "steps"), `${job}.steps`);
    return steps.some((step) => {
      const run = at(step, "run");
      return (
        typeof run === "string" && run.includes("scripts/ci-result.test.ts")
      );
    });
  });

  expect(runsCiResultTest).toBe(true);
});
