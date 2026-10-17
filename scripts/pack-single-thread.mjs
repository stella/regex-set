import {
  copyFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { gzipSync } from "node:zlib";

const root = new URL("../", import.meta.url);
const dist = new URL("wasm/dist/", root);
const binary = new URL(
  "regex-set.single-thread.wasm",
  root,
);
const bytes = await readFile(binary);
const base64 = bytes.toString("base64");
const sizes = {
  wasmBytes: bytes.length,
  base64Bytes: base64.length,
  base64OverheadBytes: base64.length - bytes.length,
  wasmGzipBytes: gzipSync(bytes).length,
  base64GzipBytes: gzipSync(base64).length,
};
await mkdir(dist, { recursive: true });
await copyFile(
  binary,
  new URL("regex-set.single-thread.wasm", dist),
);
await writeFile(
  new URL("single-thread-inline.mjs", dist),
  `import { initSync as initialize } from "./single-thread.mjs";
export * from "./single-thread.mjs";
const base64 = "${base64}";
export const initSync = () => initialize(Uint8Array.from(atob(base64), c => c.charCodeAt(0)));
`,
);
await writeFile(
  new URL("single-thread-size.json", dist),
  `${JSON.stringify(sizes, null, 2)}\n`,
);
console.log(
  "Single-thread WASM size:",
  JSON.stringify(sizes),
);
await writeFile(
  new URL("single-thread-inline.d.mts", dist),
  `export * from "./single-thread.mjs";
export declare const initSync: () => void;
`,
);
