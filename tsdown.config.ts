import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/wasm.ts"],
  format: ["esm"],
  dts: { resolve: true, autoAddExts: true },
  clean: true,
  sourcemap: true,
  external: [/index\.js/, /regex-set\.wasi/],
  hash: false,
});
