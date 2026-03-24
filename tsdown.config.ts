import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/lib.ts"],
  format: ["esm", "cjs"],
  dts: true,
  unbundle: true,
  clean: true,
  sourcemap: true,
  external: ["../index.js"],
});
