import {
  RegexSet as CoreRegexSet,
  type NativeBinding,
} from "./core";
import { createSingleThreadBinding } from "./single-thread-binding";

export type {
  Match,
  Options,
  PatternEntry,
  NamedPattern,
} from "./core";

export type WasmBytes = ArrayBuffer | Uint8Array;
export type InitSource = WasmBytes | URL | string;

let binding: NativeBinding | undefined;

const wasmBuffer = (bytes: WasmBytes): ArrayBuffer => {
  const view = ArrayBuffer.isView(bytes)
    ? new Uint8Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      )
    : new Uint8Array(bytes);
  return Uint8Array.from(view).buffer;
};

const getBinding = () => {
  if (!binding)
    throw new Error(
      "Call init() or initSync() before constructing a matcher",
    );
  return binding;
};

/** Initialize synchronously from bytes already available to the caller. No I/O. */
export const initSync = (bytes: WasmBytes): void => {
  const module = new WebAssembly.Module(wasmBuffer(bytes));
  const instance = new WebAssembly.Instance(module, {});
  binding = createSingleThreadBinding(instance.exports);
};

/** Initialize from bytes (no I/O) or an explicit caller-supplied URL. */
export const init = async (
  source: InitSource,
): Promise<void> => {
  let bytes: WasmBytes;
  if (typeof source === "string" || source instanceof URL) {
    const response = await fetch(source);
    if (!response.ok)
      throw new Error(
        `Unable to load WASM: ${response.status} ${response.statusText}`,
      );
    bytes = await response.arrayBuffer();
  } else {
    bytes = source;
  }
  const { instance } = await WebAssembly.instantiate(
    wasmBuffer(bytes),
    {},
  );
  binding = createSingleThreadBinding(instance.exports);
};

export class RegexSet extends CoreRegexSet {
  protected static override getBinding(): NativeBinding {
    return getBinding();
  }
}
