import { describe, expect, test } from "bun:test";

import { normalizeGeneratedLoader } from "./generated-loader-normalization.mjs";

describe("normalizeGeneratedLoader", () => {
  test("removes generator suppression comments without changing the code", () => {
    const generated = `/* eslint-disable */
// oxlint-disable-next-line no-eval -- generated worker
// @ts-nocheck
// @ts-expect-error generated declaration
// prettier-ignore
const worker = true;${"  "}
`;

    expect(normalizeGeneratedLoader(generated)).toBe(
      "const worker = true;\n",
    );
  });
});
