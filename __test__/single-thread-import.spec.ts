import { expect, test } from "bun:test";

test("source import performs no I/O, allocation or worker startup in an SAB-less runtime", () => {
  const entry = new URL(
    "../src/single-thread.ts",
    import.meta.url,
  ).href;
  const result = Bun.spawnSync([
    process.execPath,
    "-e",
    `
    Reflect.deleteProperty(globalThis, 'SharedArrayBuffer');
    Reflect.deleteProperty(globalThis, 'Worker');
    globalThis.fetch = () => { throw new Error('unexpected fetch'); };
    WebAssembly.Memory = new Proxy(WebAssembly.Memory, {construct() { throw new Error('unexpected memory'); }});
    WebAssembly.Module = new Proxy(WebAssembly.Module, {construct() { throw new Error('unexpected compilation'); }});
    const api = await import(${JSON.stringify(entry)});
    try { new api.RegexSet(['x']); throw new Error('missing initialization accepted'); }
    catch (error) { if (!error.message.includes('Call init()')) throw error; }
  `,
  ]);
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
