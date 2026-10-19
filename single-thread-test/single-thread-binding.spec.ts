import { describe, expect, test } from "bun:test";

import { requireWasmExports } from "../src/single-thread-runtime";

describe("single-thread WASM exports", () => {
  test("rejects malformed exports with a clear error", async () => {
    const module = await WebAssembly.compile(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    );
    const instance = await WebAssembly.instantiate(module);
    expect(() => requireWasmExports(instance)).toThrow(
      "Invalid single-thread WebAssembly exports: expected memory and alloc, dispatch, output_pointer, and output_length functions",
    );
  });
});
