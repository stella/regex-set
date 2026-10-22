export type WasmExports = {
  memory: WebAssembly.Memory;
  alloc: (length: number) => number;
  dispatch: (pointer: number, length: number) => void;
  output_pointer: () => number;
  output_length: () => number;
};

export const isWasmExports = (
  value: Record<string, unknown>,
): value is Record<string, unknown> & WasmExports =>
  value["memory"] instanceof WebAssembly.Memory &&
  typeof value["alloc"] === "function" &&
  typeof value["dispatch"] === "function" &&
  typeof value["output_pointer"] === "function" &&
  typeof value["output_length"] === "function";

export const requireWasmExports = (instance: {
  exports: Record<string, unknown>;
}): WasmExports => {
  if (!isWasmExports(instance.exports)) {
    throw new TypeError(
      "Invalid single-thread WebAssembly exports: expected memory and alloc, dispatch, output_pointer, and output_length functions",
    );
  }
  return instance.exports;
};
