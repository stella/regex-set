import { expect, mock, test } from "bun:test";

import { createSingleThreadBinding } from "../src/single-thread-binding";

const transport = () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  new DataView(memory.buffer).setUint32(128, 1, true);
  return {
    memory,
    regex_input_alloc: mock(() => 0),
    regex_run: mock(() => 0),
    regex_output_ptr: mock(() => 128),
    regex_output_len: mock(() => 4),
  } satisfies WebAssembly.Exports;
};

for (const operation of [
  "regex_input_alloc",
  "regex_run",
  "regex_output_ptr",
  "regex_output_len",
] as const) {
  test(`a trap in ${operation} prevents later calls and finalization`, () => {
    const cleanups: Array<() => void> = [];
    const originalRegistry = globalThis.FinalizationRegistry;
    globalThis.FinalizationRegistry = new Proxy(originalRegistry, {
      construct(target, args) {
        const callback = args.at(0);
        if (typeof callback !== "function")
          throw new Error("Missing cleanup callback");
        cleanups.push(() => callback(1));
        return Reflect.construct(target, args);
      },
    });
    try {
      const exports = transport();
      const binding = createSingleThreadBinding(exports);
      const matcher = new binding.RegexSet(["x"]);
      const trap = new WebAssembly.RuntimeError("unreachable");
      exports[operation].mockImplementation(() => {
        throw trap;
      });
      expect(() => matcher.isMatch("x")).toThrow(trap);
      const allocations = exports.regex_input_alloc.mock.calls.length;
      expect(() => matcher.isMatch("x")).toThrow(
        "call init() or initSync() again",
      );
      expect(() => new binding.RegexSet(["y"])).toThrow(
        "call init() or initSync() again",
      );
      expect(cleanups).toHaveLength(1);
      for (const cleanup of cleanups) cleanup();
      expect(exports.regex_input_alloc.mock.calls.length).toBe(allocations);
      const fresh = createSingleThreadBinding(transport());
      expect(new fresh.RegexSet(["x"]).isMatch("x")).toBe(true);
    } finally {
      globalThis.FinalizationRegistry = originalRegistry;
    }
  });
}

test("ordinary operation errors leave the instance usable", () => {
  const exports = transport();
  const binding = createSingleThreadBinding(exports);
  const matcher = new binding.RegexSet(["x"]);
  exports.regex_run.mockImplementationOnce(() => {
    throw new Error("ordinary error");
  });
  expect(() => matcher.isMatch("x")).toThrow("ordinary error");
  expect(matcher.isMatch("x")).toBe(true);
});

test("a finalizer trap is contained and prevents subsequent WASM calls", () => {
  const cleanups: Array<() => void> = [];
  const originalRegistry = globalThis.FinalizationRegistry;
  globalThis.FinalizationRegistry = new Proxy(originalRegistry, {
    construct(target, args) {
      const callback = args.at(0);
      if (typeof callback !== "function")
        throw new Error("Missing cleanup callback");
      cleanups.push(() => callback(1));
      return Reflect.construct(target, args);
    },
  });
  try {
    const exports = transport();
    const binding = createSingleThreadBinding(exports);
    const matcher = new binding.RegexSet(["x"]);
    exports.regex_run.mockImplementation(() => {
      throw new WebAssembly.RuntimeError("unreachable");
    });
    expect(cleanups).toHaveLength(1);
    for (const cleanup of cleanups) {
      expect(cleanup).not.toThrow();
      expect(cleanup).not.toThrow();
    }
    expect(exports.regex_run).toHaveBeenCalledTimes(2);
    expect(() => matcher.isMatch("x")).toThrow(
      "call init() or initSync() again",
    );
  } finally {
    globalThis.FinalizationRegistry = originalRegistry;
  }
});
