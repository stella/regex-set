/* Main entry point -- loads the native NAPI-RS
 * binding and re-exports the public API. */

import native from "../index.cjs";
import { initBinding } from "./core";

initBinding(native);

export { RegexSet } from "./core";

export type {
  Match,
  NamedPattern,
  NativeBinding,
  Options,
  PatternEntry,
} from "./core";
