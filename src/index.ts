/* Main entry point -- loads the native NAPI-RS
 * binding and re-exports the public API. */

import { createRequire } from "node:module";

import { initBinding, type NativeBinding } from "./core";

const require = createRequire(import.meta.url);
// SAFETY: NAPI-RS auto-generated loader returns the
// native binding object; its shape is validated by
// usage in the core classes.
const native = require("../index.js") as NativeBinding;

initBinding(native);

export { RegexSet } from "./core";

export type {
  Match,
  NamedPattern,
  NativeBinding,
  Options,
  PatternEntry,
} from "./core";
