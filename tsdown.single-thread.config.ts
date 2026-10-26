import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/single-thread.ts"],
    outDir: "wasm/dist",
    format: ["esm"],
    dts: { generator: "oxc" },
    clean: false,
    sourcemap: true,
    hash: false,
    copy: [
      {
        from: "regex-set.single-thread.wasm",
        to: "wasm/dist",
      },
    ],
  },
  {
    entry: ["src/single-thread-inline.ts"],
    outDir: "wasm/dist",
    format: ["esm"],
    dts: { generator: "oxc" },
    clean: false,
    sourcemap: true,
    hash: false,
  },
]);
