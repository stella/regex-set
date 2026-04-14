import { describe, expect, mock, test } from "bun:test";

import stllRegexSetWasmVite, {
  WASM_VITE_PACKAGES,
  buildRegexSetWasmViteConfig,
} from "../src/vite";
import { injectWasmFetchGuard } from "../src/wasm-fetch-guard";

describe("stllRegexSetWasmVite", () => {
  test("merges optimizeDeps.exclude and ssr.external", () => {
    const config = buildRegexSetWasmViteConfig({
      optimizeDeps: { exclude: ["existing-package"] },
      ssr: { external: ["server-only-dep"] },
    });

    expect(config.optimizeDeps?.exclude).toEqual([
      "existing-package",
      ...WASM_VITE_PACKAGES,
    ]);
    expect(config.ssr?.external).toEqual([
      "server-only-dep",
      ...WASM_VITE_PACKAGES,
    ]);
  });

  test("preserves ssr.external=true", () => {
    const config = buildRegexSetWasmViteConfig({
      ssr: { external: true },
    });

    expect(config.ssr?.external).toBe(true);
  });

  test("plugin returns merged vite config", () => {
    const plugin = stllRegexSetWasmVite();

    expect(plugin.name).toBe("stll-regex-set-wasm");
    expect(plugin.config?.({
      optimizeDeps: { exclude: ["existing-package"] },
    })).toEqual({
      optimizeDeps: {
        exclude: ["existing-package", ...WASM_VITE_PACKAGES],
      },
      ssr: {
        external: [...WASM_VITE_PACKAGES],
      },
    });
  });
});

describe("injectWasmFetchGuard", () => {
  test("wraps the napi-rs fetch with a wasm byte check", () => {
    const code = `
const bytes = await fetch(__wasmUrl).then((res) => res.arrayBuffer())
`;

    const transformed = injectWasmFetchGuard(
      code,
      "regex-set.wasi-browser.js",
      "@stll/regex-set-wasm",
    );

    expect(transformed).toContain("const view = new Uint8Array(bytes)");
    expect(transformed).toContain("view[0] !== 0x00");
    expect(transformed).toContain("@stll/regex-set-wasm/vite");
  });

  test("warns when napi-rs loader format changes", () => {
    const warn = mock();

    const transformed = injectWasmFetchGuard(
      "const bytes = await fetch(url)",
      "regex-set.wasi-browser.js",
      "@stll/regex-set-wasm",
      warn,
    );

    expect(transformed).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(
      "The magic-bytes guard was not applied",
    );
  });

  test("ignores non-wasi browser loaders", () => {
    const warn = mock();

    const transformed = injectWasmFetchGuard(
      "await fetch(__wasmUrl).then((res) => res.arrayBuffer())",
      "other-file.js",
      "@stll/regex-set-wasm",
      warn,
    );

    expect(transformed).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
