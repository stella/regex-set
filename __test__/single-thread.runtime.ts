import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  RegexSet as CoreRegexSet,
  type NativeBinding,
  type Options,
  type PatternEntry,
} from "../src/core";
import {
  RegexSet,
  init,
  initSync,
} from "../src/single-thread";

const bytes = readFileSync(
  new URL(
    "../regex-set.single-thread.wasm",
    import.meta.url,
  ),
);

test("import defers initialization; artifact has no imports or shared memory", () => {
  expect(() => new RegexSet(["a"])).toThrow("Call init()");
  const module = new WebAssembly.Module(bytes);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const memory = new WebAssembly.Instance(module).exports
    .memory;
  if (!(memory instanceof WebAssembly.Memory))
    throw new Error("Missing WASM memory");
  expect(memory.buffer).toBeInstanceOf(ArrayBuffer);
  initSync(bytes);
  expect(new RegexSet(["😀"]).findIter("a😀b")).toEqual([
    { pattern: 0, start: 1, end: 3, text: "😀" },
  ]);
});

test("both initializers honor Buffer and Uint8Array subarray bounds", async () => {
  const allocation = Buffer.alloc(
    bytes.byteLength + 64,
    0xa5,
  );
  allocation.set(bytes, 32);
  const buffer = allocation.subarray(
    32,
    32 + bytes.byteLength,
  );
  const typed = new Uint8Array(
    allocation.buffer,
    allocation.byteOffset + 32,
    bytes.byteLength,
  );
  expect(buffer.byteOffset).toBeGreaterThan(
    allocation.byteOffset,
  );
  for (const view of [buffer, typed]) {
    expect(WebAssembly.validate(view)).toBe(true);
    initSync(view);
    expect(new RegexSet(["valid"]).isMatch("valid")).toBe(
      true,
    );
    await init(view);
    expect(new RegexSet(["😀"]).findIter("a😀")).toEqual([
      { pattern: 0, start: 1, end: 3, text: "😀" },
    ]);
  }
});

test("packed inline import, init and match work without SAB, Worker, network or file fetching", () => {
  const entry = new URL(
    "../wasm/dist/single-thread-inline.mjs",
    import.meta.url,
  ).href;
  const result = Bun.spawnSync([
    process.execPath,
    "-e",
    `
    Reflect.deleteProperty(globalThis, 'SharedArrayBuffer');
    Reflect.deleteProperty(globalThis, 'Worker');
    globalThis.fetch = () => { throw new Error('unexpected fetch'); };
    Bun.file = () => { throw new Error('unexpected file fetch'); };
    const Memory = WebAssembly.Memory;
    WebAssembly.Memory = new Proxy(Memory, {construct() { throw new Error('import allocated memory'); }});
    const {initSync, RegexSet} = await import(${JSON.stringify(entry)});
    WebAssembly.Memory = Memory;
    initSync();
    if (JSON.stringify(new RegexSet(['😀', 'é']).findIter('a😀é')) !== JSON.stringify([{pattern:0,start:1,end:3,text:'😀'},{pattern:1,start:3,end:4,text:'é'}])) throw new Error('matches differ');
  `,
  ]);
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

test("explicit initialization accepts bytes or caller URL and preserves binding after HTTP failure", async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  try {
    globalThis.fetch = (async (input) => {
      requested.push(String(input));
      return new Response(bytes);
    }) as typeof fetch;
    await init(bytes);
    expect(requested).toEqual([]);
    await init(
      new URL("https://extension.invalid/engine.wasm"),
    );
    expect(requested).toEqual([
      "https://extension.invalid/engine.wasm",
    ]);
    expect(new RegexSet(["ok"]).isMatch("ok")).toBe(true);
    globalThis.fetch = (async () =>
      new Response("missing", {
        status: 404,
      })) as typeof fetch;
    await expect(
      init("https://extension.invalid/missing.wasm"),
    ).rejects.toThrow("404");
    expect(
      new RegexSet(["still initialized"]).isMatch(
        "still initialized",
      ),
    ).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("npm tarball contains and runs the single-thread entry and its runtime imports", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "regex-single-thread-pack-"),
  );
  try {
    const output = execFileSync(
      "npm",
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        directory,
      ],
      {
        cwd: new URL("../wasm/", import.meta.url),
        encoding: "utf8",
      },
    );
    const [packed] = JSON.parse(output);
    const files = packed.files.map(
      (file: { path: string }) => file.path,
    );
    for (const expected of [
      "dist/single-thread.mjs",
      "dist/single-thread.d.mts",
      "dist/single-thread-inline.mjs",
      "dist/single-thread-inline.d.mts",
      "dist/regex-set.single-thread.wasm",
      "dist/single-thread-size.json",
    ])
      expect(files).toContain(expected);
    execFileSync("tar", [
      "-xzf",
      join(directory, packed.filename),
      "-C",
      directory,
    ]);
    const entry = pathToFileURL(
      join(
        directory,
        "package/dist/single-thread-inline.mjs",
      ),
    ).href;
    const result = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `
      globalThis.fetch = () => {throw new Error('unexpected fetch')};
      Reflect.deleteProperty(globalThis, 'SharedArrayBuffer');
      Reflect.deleteProperty(globalThis, 'Worker');
      const {initSync, RegexSet} = await import(${JSON.stringify(entry)});
      initSync();
      if (!new RegexSet(['packed']).isMatch('packed')) throw new Error('packed runtime failed');
    `,
      ],
      { cwd: directory },
    );
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("single-thread and existing threaded bindings produce identical public API results", async () => {
  const require = createRequire(import.meta.url);
  // SAFETY: generated NAPI loader exposes the binding contract exercised below.
  const threaded =
    require("../regex-set.wasi.cjs") as NativeBinding;
  class ThreadedSet extends CoreRegexSet {
    protected static override getBinding() {
      return threaded;
    }
  }
  initSync(bytes);
  try {
    const corpus: {
      patterns: PatternEntry[];
      text: string;
    }[] = [
      {
        patterns: ["foo", "foobar", "bar", "foo"],
        text: "foobar foo",
      },
      { patterns: [/hello/iu, /\d+/u], text: "HELLO 123" },
      {
        patterns: ["😀", "é", "中", "İ"],
        text: "😀é中 İ i",
      },
      {
        patterns: [{ pattern: "foo", name: "named" }],
        text: "foo",
      },
      { patterns: ["(?<!a)b", "a+"], text: "aaab b" },
      { patterns: ["\ud800"], text: "a\ud800b" },
      { patterns: [], text: "anything" },
      { patterns: ["absent"], text: "" },
    ];
    for (const caseInsensitive of [false, true]) {
      for (const wholeWords of [false, true]) {
        for (const unicodeBoundaries of [false, true]) {
          const options: Options = {
            caseInsensitive,
            wholeWords,
            unicodeBoundaries,
          };
          for (const { patterns, text } of corpus) {
            const single = new RegexSet(patterns, options);
            const original = new ThreadedSet(
              patterns,
              options,
            );
            expect(single.patternCount).toBe(
              original.patternCount,
            );
            expect(single.isMatch(text)).toBe(
              original.isMatch(text),
            );
            expect(single.findIter(text)).toEqual(
              original.findIter(text),
            );
            expect(single.whichMatch(text)).toEqual(
              original.whichMatch(text),
            );
            const replacements = patterns.map(
              (_, index) => `[${index}]`,
            );
            expect(
              single.replaceAll(text, replacements),
            ).toBe(original.replaceAll(text, replacements));
            const prepared = ThreadedSet.prepare(
              patterns,
              options,
            );
            expect(
              new RegexSet(
                patterns,
                options,
                prepared,
              ).findIter(text),
            ).toEqual(original.findIter(text));
            const singlePrepared = RegexSet.prepare(
              patterns,
              options,
            );
            expect(
              new ThreadedSet(
                patterns,
                options,
                singlePrepared,
              ).findIter(text),
            ).toEqual(single.findIter(text));
          }
        }
      }
    }
    await init(bytes);
    expect(new ThreadedSet(["old"]).isMatch("old")).toBe(
      true,
    );
    expect(new RegexSet(["new"]).isMatch("new")).toBe(true);
  } finally {
    const dispose = Reflect.get(
      threaded,
      Symbol.for("napi.rs.wasi.dispose"),
    );
    if (typeof dispose === "function") await dispose();
  }
});
