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

export type WasmBytes = ArrayBuffer | ArrayBufferView;
export type InitSource =
  | WasmBytes
  | URL
  | string
  | Request
  | Response;

let binding: NativeBinding | undefined;

const isWasmBytes = (
  source: unknown,
): source is WasmBytes =>
  ArrayBuffer.isView(source) ||
  Object.prototype.toString.call(source) ===
    "[object ArrayBuffer]";

const isResponse = (
  source: InitSource,
): source is Response =>
  typeof source === "object" &&
  "ok" in source &&
  typeof source.ok === "boolean" &&
  "arrayBuffer" in source &&
  typeof source.arrayBuffer === "function";

const wasmBuffer = (bytes: WasmBytes): ArrayBuffer => {
  if (!isWasmBytes(bytes))
    throw new TypeError(
      "Expected an ArrayBuffer or ArrayBuffer view",
    );
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

/** Initialize from bytes, a response body, or a caller-supplied fetch source. */
export const init = async (
  source: InitSource,
): Promise<void> => {
  let bytes: WasmBytes;
  if (isWasmBytes(source)) {
    bytes = source;
  } else {
    const response = isResponse(source)
      ? source
      : await fetch(source);
    if (!response.ok)
      throw new Error(
        `Unable to load WASM: ${response.status} ${response.statusText}`,
      );
    bytes = await response.arrayBuffer();
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
