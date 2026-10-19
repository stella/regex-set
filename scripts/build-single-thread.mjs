import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { gzipSync } from "node:zlib";

execFileSync(
  "cargo",
  [
    "build",
    "-p",
    "stella-regex-set-wasm-single-thread",
    "--target",
    "wasm32-unknown-unknown",
    "--release",
    "--locked",
  ],
  { stdio: "inherit" },
);
const source =
  "target/wasm32-unknown-unknown/release/stella_regex_set_wasm_single_thread.wasm";
const destination = "regex-set.single-thread.wasm";
copyFileSync(source, destination);
const bytes = readFileSync(destination);
const base64 = bytes.toString("base64");
writeFileSync(
  "src/single-thread-inline.ts",
  `import { initSync as initialize, RegexSet } from "./single-thread";\n\nconst wasm = "${base64}";\nexport const initSync = () => initialize(Uint8Array.from(atob(wasm), c => c.charCodeAt(0)));\nexport { RegexSet };\n`,
);
const sizes = {
  wasm: bytes.length,
  base64: base64.length,
  gzip: gzipSync(bytes).length,
};
mkdirSync("wasm/dist", { recursive: true });
writeFileSync(
  "wasm/dist/single-thread-size.json",
  `${JSON.stringify(sizes, null, 2)}\n`,
);
console.log("single-thread WASM sizes", sizes);
