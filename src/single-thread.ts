import { initBinding } from "./core";
import { createSingleThreadBinding } from "./single-thread-binding";
import { requireWasmExports } from "./single-thread-runtime";

export type InitSource =
  ArrayBuffer | ArrayBufferView | URL | string | Request | Response;

let generation = 0;

const install = (instance: WebAssembly.Instance) => {
  const current = ++generation;
  initBinding(
    createSingleThreadBinding(requireWasmExports(instance), () => {
      if (generation === current) generation++;
    }),
  );
};

const isBufferSource = (
  source: InitSource,
): source is ArrayBuffer | ArrayBufferView =>
  Object.prototype.toString.call(source) === "[object ArrayBuffer]" ||
  ArrayBuffer.isView(source);

const isResponse = (source: InitSource): source is Response =>
  typeof source === "object" &&
  "arrayBuffer" in source &&
  "ok" in source &&
  "status" in source;

export const initSync = (source: ArrayBuffer | ArrayBufferView) => {
  install(new WebAssembly.Instance(new WebAssembly.Module(source), {}));
};

export const init = async (source: InitSource) => {
  let bytes: ArrayBuffer | ArrayBufferView;
  if (isBufferSource(source)) bytes = source;
  else if (isResponse(source)) {
    if (!source.ok)
      throw new Error(`Unable to load WebAssembly: HTTP ${source.status}`);
    bytes = await source.arrayBuffer();
  } else {
    const response = await fetch(source);
    if (!response.ok)
      throw new Error(`Unable to load WebAssembly: HTTP ${response.status}`);
    bytes = await response.arrayBuffer();
  }
  const result = await WebAssembly.instantiate(bytes, {});
  install(result.instance);
};

export { RegexSet } from "./core";
export type { Match, NamedPattern, Options, PatternEntry } from "./core";
