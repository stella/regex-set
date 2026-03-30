/* Browser/WASM entry point -- loads the WASM binding
 * from the generated browser glue and re-exports the
 * public API through the shared core. */

import native from "../regex-set.wasi-browser.js";

import { initBinding, type NativeBinding } from "./core";

initBinding(native as unknown as NativeBinding);

export { RegexSet } from "./core";

export type {
  Match,
  NamedPattern,
  NativeBinding,
  Options,
  PatternEntry,
} from "./core";
