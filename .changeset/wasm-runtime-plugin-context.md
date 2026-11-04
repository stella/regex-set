---
"@stll/regex-set": patch
---

The WebAssembly packages use emnapi 2.0.0-beta.2 with `@napi-rs/wasm-runtime` 1.2.6, the runtime release built for that emnapi version. With emnapi 2.0.0-beta.1 and wasm-runtime 1.2.5, the threaded WebAssembly build failed to load in browsers with `Cannot set properties of undefined (setting 'initWorker')`.
