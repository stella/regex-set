import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

const isRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value);

const narrowWorkflow = (value: unknown, name: string) => {
  if (
    !isRecord(value) ||
    !isRecord(value.on) ||
    !isRecord(value.jobs)
  ) {
    throw new Error(
      `${name}: expected workflow on/jobs mappings`,
    );
  }
  const jobs = value.jobs;
  return {
    on: value.on,
    jobNames: Object.keys(jobs),
    job: (id: string) => {
      const job = jobs[id];
      if (!isRecord(job))
        throw new Error(`${name}: missing job ${id}`);
      if (
        job.uses !== undefined &&
        typeof job.uses !== "string"
      ) {
        throw new Error(
          `${name}/${id}: expected string uses`,
        );
      }
      if (job.with !== undefined && !isRecord(job.with)) {
        throw new Error(
          `${name}/${id}: expected with mapping`,
        );
      }
      const steps = job.steps;
      if (steps !== undefined && !Array.isArray(steps)) {
        throw new Error(
          `${name}/${id}: expected steps array`,
        );
      }
      return {
        uses: job.uses,
        with: job.with,
        steps: (steps ?? []).map((step: unknown) => {
          if (!isRecord(step))
            throw new Error(
              `${name}/${id}: expected step mapping`,
            );
          if (
            step.run !== undefined &&
            typeof step.run !== "string"
          ) {
            throw new Error(
              `${name}/${id}: expected string run`,
            );
          }
          if (
            step.uses !== undefined &&
            typeof step.uses !== "string"
          ) {
            throw new Error(
              `${name}/${id}: expected string step uses`,
            );
          }
          if (
            step.with !== undefined &&
            !isRecord(step.with)
          ) {
            throw new Error(
              `${name}/${id}: expected step with mapping`,
            );
          }
          return {
            run: step.run,
            uses: step.uses,
            if: step.if,
            with: step.with,
          };
        }),
      };
    },
  };
};

const workflow = (name: string) =>
  narrowWorkflow(
    Bun.YAML.parse(
      readFileSync(
        new URL(
          `../.github/workflows/${name}.yml`,
          import.meta.url,
        ),
        "utf8",
      ),
    ),
    name,
  );

test("optional proofs run only on demand while shared CI remains enabled", () => {
  const optional = workflow("optional-proofs");
  const ci = workflow("ci");
  expect(Object.keys(optional.on)).toEqual([
    "workflow_dispatch",
  ]);
  expect(optional.jobNames.sort()).toEqual([
    "contract-perf",
    "typecheck-parity",
  ]);
  expect(ci.jobNames).not.toContain("contract-perf");
  expect(ci.job("napi-ci").uses).toContain(
    "/rust-napi-ci.yml@",
  );
  expect(
    ci
      .job("checks")
      .steps.some(
        (step) => step.run === "bun run typecheck",
      ),
  ).toBe(false);
  expect(ci.job("napi-ci").with?.typecheck).toBe(true);
  expect(
    ci
      .job("checks")
      .steps.some(
        (step) =>
          step.run === "bun run check:typecheck-parity",
      ),
  ).toBe(false);
  expect(
    optional
      .job("typecheck-parity")
      .steps.some(
        (step) =>
          step.run === "bun run check:typecheck-parity",
      ),
  ).toBe(true);
  expect(
    optional
      .job("contract-perf")
      .steps.some(
        (step) =>
          step.run ===
          "timeout 180s bun run perf:contracts",
      ),
  ).toBe(true);
});

test("workflow checkouts do not persist repository credentials", () => {
  const files = readdirSync(
    new URL("../.github/workflows/", import.meta.url),
  );
  for (const file of files.filter((name) =>
    /\.ya?ml$/u.test(name),
  )) {
    const parsed = workflow(file.replace(/\.ya?ml$/u, ""));
    for (const job of parsed.jobNames) {
      for (const step of parsed.job(job).steps) {
        if (
          step.uses === undefined ||
          !step.uses.startsWith("actions/checkout@")
        )
          continue;
        expect(
          step.with?.["persist-credentials"],
          `${file}: ${job}`,
        ).toBe(false);
      }
    }
  }
});

test("workflow views reject malformed YAML shapes with a useful location", () => {
  for (const value of [
    null,
    [],
    { on: [], jobs: {} },
    { on: {}, jobs: null },
  ]) {
    expect(() => narrowWorkflow(value, "fixture")).toThrow(
      "fixture: expected workflow on/jobs mappings",
    );
  }
  for (const job of [
    null,
    { uses: 1 },
    { with: [] },
    { steps: "run" },
    { steps: [null] },
    { steps: [{ run: 1 }] },
    { steps: [{ uses: false }] },
    { steps: [{ with: [] }] },
  ]) {
    expect(() =>
      narrowWorkflow(
        { on: {}, jobs: { proofs: job } },
        "fixture",
      ).job("proofs"),
    ).toThrow("fixture");
  }
  const shared = narrowWorkflow(
    {
      on: {},
      jobs: { shared: { uses: "owner/repo/workflow@sha" } },
    },
    "fixture",
  );
  expect(shared.job("shared").steps).toEqual([]);
  expect(() => shared.job("missing")).toThrow(
    "fixture: missing job missing",
  );
});
