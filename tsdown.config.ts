import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  unbundle: true,
  clean: true,
  sourcemap: true,
  hash: false,
  external: ["../index.js"],
});
