import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";

import nativeBinding from "../index.cjs";
import { initBinding } from "../src/core";
import { RegexSet as NativeRegexSet } from "../src/index";

test("single-thread entry imports without initialization side effects", async () => {
  const fetchSpy = spyOn(globalThis, "fetch");
  const instantiateSpy = spyOn(
    WebAssembly,
    "instantiate",
  );
  const instantiateStreamingSpy = spyOn(
    WebAssembly,
    "instantiateStreaming",
  );
  const compileSpy = spyOn(WebAssembly, "compile");
  const OriginalModule = WebAssembly.Module;
  const OriginalInstance = WebAssembly.Instance;
  let moduleCalls = 0;
  let instanceCalls = 0;
  Object.defineProperty(WebAssembly, "Module", {
    configurable: true,
    value: new Proxy(OriginalModule, {
      construct(target, argumentsList, newTarget) {
        moduleCalls++;
        return Reflect.construct(target, argumentsList, newTarget);
      },
    }),
  });
  Object.defineProperty(WebAssembly, "Instance", {
    configurable: true,
    value: new Proxy(OriginalInstance, {
      construct(target, argumentsList, newTarget) {
        instanceCalls++;
        return Reflect.construct(target, argumentsList, newTarget);
      },
    }),
  });

  try {
    const entry = await import(
      `../src/single-thread?import-side-effect=${crypto.randomUUID()}`
    );
    const invocationCount = () =>
      fetchSpy.mock.calls.length +
      instantiateSpy.mock.calls.length +
      instantiateStreamingSpy.mock.calls.length +
      compileSpy.mock.calls.length +
      moduleCalls +
      instanceCalls;

    expect(entry.init).toBeFunction();
    expect(entry.initSync).toBeFunction();
    expect(entry.RegexSet).toBeFunction();
    expect(invocationCount()).toBe(0);

    entry.initSync(
      readFileSync("regex-set.single-thread.wasm"),
    );
    expect(invocationCount()).toBeGreaterThan(0);
  } finally {
    fetchSpy.mockRestore();
    instantiateSpy.mockRestore();
    instantiateStreamingSpy.mockRestore();
    compileSpy.mockRestore();
    Object.defineProperty(WebAssembly, "Module", {
      configurable: true,
      value: OriginalModule,
    });
    Object.defineProperty(WebAssembly, "Instance", {
      configurable: true,
      value: OriginalInstance,
    });
  }
});

test("single-thread runtime searches and preserves a leading BOM", async () => {
  const entry = await import("../src/single-thread");
  entry.initSync(
    readFileSync("regex-set.single-thread.wasm"),
  );
  const set = new entry.RegexSet(["x"]);
  expect(set.isMatch("x")).toBe(true);
  expect(set.replaceAll("\uFEFFx", ["y"])).toBe("\uFEFFy");
});

test("single-thread runtime recovers after a WebAssembly trap", async () => {
  const entry = await import("../src/single-thread");
  entry.initSync(
    readFileSync("single-thread-test/trap-after-create.wasm"),
  );
  const trapped = new entry.RegexSet(["x"]);

  expect(() => trapped.isMatch("x")).toThrow(
    WebAssembly.RuntimeError,
  );
  expect(() => trapped.whichMatch("x")).toThrow(
    "The single-thread WebAssembly instance trapped; call init() or initSync() again",
  );

  entry.initSync(
    readFileSync("regex-set.single-thread.wasm"),
  );
  const recovered = new entry.RegexSet(["x"]);
  expect(recovered.isMatch("x")).toBe(true);
});

test.each(["\uD800", "\uDC00"])(
  "single-thread matches native lone surrogate behavior for %s",
  async (surrogate) => {
    const pattern = `before${surrogate}after`;
    const haystack = `x${pattern}y`;
    initBinding(nativeBinding);
    const native = new NativeRegexSet([pattern]);
    const expected = {
      isMatch: native.isMatch(haystack),
      matches: native.findIter(haystack),
      which: native.whichMatch(haystack),
      replaced: native.replaceAll(haystack, ["match"]),
    };

    const entry = await import("../src/single-thread");
    entry.initSync(
      readFileSync("regex-set.single-thread.wasm"),
    );
    const singleThread = new entry.RegexSet([pattern]);
    expect(singleThread.isMatch(haystack)).toBe(
      expected.isMatch,
    );
    expect(singleThread.findIter(haystack)).toEqual(
      expected.matches,
    );
    expect(singleThread.whichMatch(haystack)).toEqual(
      expected.which,
    );
    expect(
      singleThread.replaceAll(haystack, ["match"]),
    ).toBe(expected.replaced);
  },
);
