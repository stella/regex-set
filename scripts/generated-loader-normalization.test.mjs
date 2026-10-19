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

  test("checks for a crash before destroying the context after settlement draining", async () => {
    const generated = `
let __wasiAddonCrashFlag;
let __wasiDisposePromise;
let destroyed = 0;
let releaseDrain;
const __isThenable = (value) => value && typeof value.then === "function";
const __terminateWasiWorkers = () => {};
const __destroyEmnapiContext = () => { destroyed += 1; };
const __finishWasiDisposal = () => {};
const __drainWasmEnvCleanup = () => new Promise((resolve) => { releaseDrain = resolve; });
function __continueWasiDisposal() {
  const destroyResult = __destroyEmnapiContext();
  if (__isThenable(destroyResult)) return Promise.resolve(destroyResult).then(__finishWasiDisposal);
  return __finishWasiDisposal();
}
function __drainWasmEnvForWasiDisposal() {
  const drainResult = __drainWasmEnvCleanup();
  if (__isThenable(drainResult)) return Promise.resolve(drainResult).then(__continueWasiDisposal);
  return __continueWasiDisposal();
}
`;
    const normalized = normalizeGeneratedLoader(generated);
    // oxlint-disable-next-line typescript/no-implied-eval -- The generated loader fixture must execute to prove its disposal behavior.
    const fixture = new Function(
      `${normalized}\nreturn {
        begin() { __wasiDisposePromise = __drainWasmEnvForWasiDisposal(); return __wasiDisposePromise; },
        crash() { __wasiAddonCrashFlag = new Int32Array(new SharedArrayBuffer(4)); Atomics.store(__wasiAddonCrashFlag, 0, 1); },
        release: () => releaseDrain(),
        destroyed: () => destroyed,
      };`,
    )();
    const disposal = fixture.begin();
    fixture.crash();
    fixture.release();

    // oxlint-disable-next-line typescript/await-thenable, typescript/no-confusing-void-expression -- The generated fixture's dynamically constructed disposal value is intentionally untyped.
    await expect(disposal).rejects.toThrow(
      "worker thread crashed",
    );
    expect(fixture.destroyed()).toBe(0);
  });

  test("terminates a crashed worker during initialization rollback without another poll", async () => {
    const generated = `
let __wasiAddonCrashFlag;
let __wasiDisposePromise;
let terminated = 0;
const timers = new Set();
const __isThenable = (value) => value && typeof value.then === "function";
const __terminateWasiWorkers = () => { terminated += 1; };
const __retainFailedWasiRollback = (errors) => errors;
const __drainWasiAsyncWork = () => new Promise((resolve) => { timers.add(resolve); });
const __prepareWasmEnvCleanupWithTurns = () => {};
const __drainWasmEnvCleanup = () => {};
const __destroyContextForWasiRollback = () => [];
function __rollbackWasiInitialization() {
  function __rollbackWasmEnvForWasiInitialization() {
    const cleanupErrors = [];
    const prepareResult = __prepareWasmEnvCleanupWithTurns();
    if (__isThenable(prepareResult)) return Promise.resolve(prepareResult).then(() => __drainWasmEnvForWasiRollback(cleanupErrors));
    return __drainWasmEnvForWasiRollback(cleanupErrors);
  }
  function __drainWasmEnvForWasiRollback(cleanupErrors) {
    let drainResult = __drainWasmEnvCleanup();
    if (__isThenable(drainResult)) return Promise.resolve(drainResult).then(() => __destroyContextForWasiRollback(cleanupErrors));
    return __destroyContextForWasiRollback(cleanupErrors);
  }
  const asyncWorkResult = __drainWasiAsyncWork();
  if (__isThenable(asyncWorkResult)) return Promise.resolve(asyncWorkResult).then(__rollbackWasmEnvForWasiInitialization, (error) => __retainFailedWasiRollback([error]));
  return __rollbackWasmEnvForWasiInitialization();
}

// A view of the addon's crash flag, one word of the shared wasm memory, for the fixture.
`;
    const normalized = normalizeGeneratedLoader(generated);
    // oxlint-disable-next-line typescript/no-implied-eval -- The generated loader fixture must execute to prove its rollback behavior.
    const fixture = new Function(
      `${normalized}\nreturn {
        failInitialization: async () => { const error = new Error("initialization failed"); const cleanupErrors = await __rollbackWasiInitialization(); if (cleanupErrors.length) error.cause = cleanupErrors[0]; throw error; },
        crash() { __wasiAddonCrashFlag = new Int32Array(new SharedArrayBuffer(4)); Atomics.store(__wasiAddonCrashFlag, 0, 1); },
        runPollTimer() { const callback = timers.values().next().value; timers.delete(callback); callback(); },
        timerCount: () => timers.size,
        terminated: () => terminated,
      };`,
    )();
    const initialization = fixture.failInitialization();
    expect(fixture.timerCount()).toBe(1);
    fixture.crash();
    fixture.runPollTimer();

    // oxlint-disable-next-line typescript/await-thenable, typescript/no-confusing-void-expression -- The generated fixture's dynamically constructed initialization value is intentionally untyped.
    await expect(initialization).rejects.toThrow(
      "initialization failed",
    );
    expect(fixture.terminated()).toBe(1);
    expect(fixture.timerCount()).toBe(0);
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
