import { describe, expect, test } from "bun:test";

import { normalizeGeneratedLoader } from "./generated-loader-normalization.mjs";

describe("normalizeGeneratedLoader", () => {
  test("removes generator suppression comments without changing the code", () => {
    const generated = `/* eslint-disable */
// oxlint-disable-next-line no-eval -- generated worker
// @ts-nocheck
// @ts-expect-error generated declaration
// prettier-ignore
const worker = true;${"  "}
`;

    expect(normalizeGeneratedLoader(generated)).toBe(
      "const worker = true;\n",
    );
  });

  test("aborts browser disposal after a worker crash without leaving a poll timer", async () => {
    const generated = `
let __wasiAddonCrashFlag;
let __wasiDisposed = false;
let __wasiDisposePromise;
const timers = new Set();
let terminated = 0;
const __scheduleTimer = (callback) => timers.add(callback);
const __WASI_ASYNC_WORK_POLL_INTERVAL_MS = 1;
const __keepEventLoopAliveUntil = (promise) => promise;
const __napiInstance = {
  exports: {
    napi_wasm_async_work_pending: () => 1,
    napi_wasm_cancel_pending_async_work: () => {},
  },
};
const __isThenable = (value) => value && typeof value.then === "function";
function __terminateWasiWorkers() {
  terminated += 1;
}
function __drainWasiAsyncWork() {
  const pending = __napiInstance.exports.napi_wasm_async_work_pending;
  const readPending = () => pending();
  const drainPromise = __keepEventLoopAliveUntil(
    (async () => {
      while (readPending()) {
        await new Promise((resolve) => {
          __scheduleTimer(
            resolve,
            __WASI_ASYNC_WORK_POLL_INTERVAL_MS,
          );
        });
      }
    })(),
  );
  return drainPromise;
}
function __startWasiDisposal() {
  return __drainWasiAsyncWork();
}
function __disposeWasiBinding() {
  if (__wasiDisposePromise) {
    return __wasiDisposePromise;
  }
  if (__wasiDisposed) {
    return Promise.resolve();
  }

  let resolveDispose;
  let rejectDispose;
  const disposePromise = new Promise((resolve, reject) => {
    resolveDispose = resolve;
    rejectDispose = reject;
  });
  __wasiDisposePromise = disposePromise;

  let result;
  try {
    result = __startWasiDisposal();
  } catch (error) {
    __wasiDisposePromise = undefined;
    rejectDispose(error);
    return disposePromise;
  }

  Promise.resolve(result).then(
    (value) => {
      __wasiDisposed = true;
      resolveDispose(value);
    },
    (error) => {
      __wasiDisposePromise = undefined;
      rejectDispose(error);
    },
  );
  return disposePromise;
}
let __finishParkedWasmEnvCleanup;
const finishCleanup = () => {};
const runtimePollFixture = (pace) => {
  __finishParkedWasmEnvCleanup = finishCleanup;
  return (async () => {
      await __yieldWasmRuntimePollTurn(pace);
      try {} catch {}
  })().then(finishCleanup, finishCleanup);
};
`;
    const normalized = normalizeGeneratedLoader(generated);
    // oxlint-disable-next-line typescript/no-implied-eval -- The generated loader fixture must execute to prove its disposal behavior.
    const loadFixture = new Function(
      `${normalized}\nreturn {
        crash() {
          __wasiAddonCrashFlag = new Int32Array(new SharedArrayBuffer(4));
          Atomics.store(__wasiAddonCrashFlag, 0, 1);
        },
        dispose: __disposeWasiBinding,
        getTerminated: () => terminated,
        runPollTimer() {
          const callback = timers.values().next().value;
          timers.delete(callback);
          callback();
        },
        timerCount: () => timers.size,
      };`,
    );
    const fixture = loadFixture();
    const disposal = fixture.dispose();
    expect(fixture.timerCount()).toBe(1);

    fixture.crash();
    fixture.runPollTimer();

    // oxlint-disable-next-line typescript/await-thenable, typescript/no-confusing-void-expression -- The generated fixture's dynamically constructed disposal value is intentionally untyped.
    await expect(disposal).rejects.toThrow(
      "worker thread crashed",
    );
    expect(fixture.getTerminated()).toBe(1);
    expect(fixture.timerCount()).toBe(0);
    expect(normalized).toContain(
      "await __yieldWasmRuntimePollTurn(pace);\n      __abortWasiDisposalIfThreadCrashed();",
    );
    expect(normalized).toContain(
      "finishCleanupUnlessCrashed",
    );
    expect(normalizeGeneratedLoader(normalized)).toBe(
      normalized,
    );
  });

  test("allows an unstamped binding target in generated declarations", () => {
    const generated = `export declare const __napiBindingTarget:
  | "native"
  | "wasm32-wasi"
  | "wasm32-wasip1";
`;

    expect(normalizeGeneratedLoader(generated)).toContain(
      '| "wasm32-wasip1"\n  | undefined;',
    );
  });
});
