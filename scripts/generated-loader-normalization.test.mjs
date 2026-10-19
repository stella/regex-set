import { parse } from "acorn";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { normalizeGeneratedLoader } from "./generated-loader-normalization.mjs";

// oxlint-disable typescript/strict-boolean-expressions -- Acorn's dynamically shaped AST is fixture data inspected by the normalizer test.

const cleanupFunctionCalls = new Set([
  "__destroyEmnapiContext",
  "__drainWasmEnvCleanup",
  "__prepareWasmEnvCleanupWithTurns",
]);

const functionTypes = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

const findUncheckedContextDestructionBoundaries = (
  filename,
  content,
) => {
  const source = parse(content, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true,
  });
  const unchecked = [];
  const cleanupAliases = new Set(["finishParked"]);

  const visit = (node, callback) => {
    callback(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item?.type) visit(item, callback);
        }
      } else if (value?.type) {
        visit(value, callback);
      }
    }
  };

  visit(source, (node) => {
    if (
      node.type !== "VariableDeclarator" ||
      node.id.type !== "Identifier" ||
      node.init?.type !== "MemberExpression"
    ) {
      return;
    }
    const property = node.init.property;
    const propertyName =
      property.type === "Identifier"
        ? property.name
        : property.value;
    if (
      typeof propertyName === "string" &&
      propertyName.includes("cleanup")
    ) {
      cleanupAliases.add(node.id.name);
    }
  });

  const getFunctionName = (node, parent) => {
    if (node.id?.name) return node.id.name;
    if (parent?.type === "VariableDeclarator") {
      return parent.id.name;
    }
    if (
      ["Property", "MethodDefinition"].includes(
        parent?.type,
      )
    ) {
      return parent.key.name ?? parent.key.value;
    }
    return `<callback@${node.loc.start.line}>`;
  };

  const inspectFunction = (node, parent) => {
    const crashChecks = [];
    const boundaries = [];
    const visitBody = (child) => {
      if (
        child !== node.body &&
        functionTypes.has(child.type)
      ) {
        return;
      }
      if (child.type === "CallExpression") {
        if (child.callee.type === "Identifier") {
          if (
            [
              "__abortWasiDisposalIfThreadCrashed",
              "__hasWasiThreadCrashed",
            ].includes(child.callee.name)
          ) {
            crashChecks.push(child.start);
          } else if (
            cleanupFunctionCalls.has(child.callee.name) ||
            cleanupAliases.has(child.callee.name)
          ) {
            boundaries.push({
              name: child.callee.name,
              position: child.start,
            });
          }
        } else if (
          child.callee.type === "MemberExpression"
        ) {
          const property = child.callee.property;
          const propertyName =
            property.type === "Identifier"
              ? property.name
              : property.value;
          if (propertyName === "destroy") {
            boundaries.push({
              name: "context.destroy",
              position: child.start,
            });
          }
        }
      }
      for (const value of Object.values(child)) {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item?.type) visitBody(item);
          }
        } else if (value?.type) {
          visitBody(value);
        }
      }
    };
    visitBody(node.body);
    for (const boundary of boundaries) {
      if (
        !crashChecks.some(
          (position) => position < boundary.position,
        )
      ) {
        unchecked.push(
          `${filename}: ${getFunctionName(node, parent)} -> ${boundary.name}`,
        );
      }
    }
  };

  const visitFunctions = (node, parent) => {
    if (functionTypes.has(node.type)) {
      inspectFunction(node, parent);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item?.type) visitFunctions(item, node);
        }
      } else if (value?.type) {
        visitFunctions(value, node);
      }
    }
  };
  visitFunctions(source);
  return unchecked;
};

describe("normalizeGeneratedLoader", () => {
  test("checks every context-destroying path in both loaders for a preceding crash check", () => {
    const filenames = [
      "regex-set.wasi-browser.js",
      "regex-set.wasi.cjs",
    ];
    const unchecked = filenames.flatMap((filename) =>
      findUncheckedContextDestructionBoundaries(
        filename,
        normalizeGeneratedLoader(
          readFileSync(
            new URL(`../${filename}`, import.meta.url),
            "utf8",
          ),
        ),
      ),
    );

    expect(unchecked).toEqual([]);
  });

  test("flags an unchecked arrow callback that finishes cleanup", () => {
    const unchecked =
      findUncheckedContextDestructionBoundaries(
        "unchecked.js",
        `const finish = exports.napi_prepare_wasm_env_cleanup_finish;
const unchecked = () => finish();`,
      );

    expect(unchecked).toEqual([
      "unchecked.js: unchecked -> finish",
    ]);
  });

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

  test("aborts browser disposal after a worker startup error without leaving a poll timer", async () => {
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
const __wasiWorkers = new Set();
const __shareWasiAddonCrashFlag = () => {};
const startupListeners = {};
const startupWorker = {
  addEventListener(name, listener) { startupListeners[name] = listener; },
};
function createStartupWorker() {
      const worker = startupWorker;
      __wasiWorkers.add(worker);
      __shareWasiAddonCrashFlag(worker);

      return worker;
}
createStartupWorker();
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
        failWorkerStartup(error) { startupListeners.error({ error }); },
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

    fixture.failWorkerStartup(
      new Error("worker failed to load"),
    );
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
const threadManager = {};
const __getWasiThreadManager = () => threadManager;
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
        crash() { threadManager._fatalError = new Error("worker import failed"); },
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

  test("terminates a worker with a startup error during initialization rollback without another poll", async () => {
    const generated = `
let __wasiAddonCrashFlag;
let __wasiDisposePromise;
let terminated = 0;
const timers = new Set();
const __isThenable = (value) => value && typeof value.then === "function";
const __wasiWorkers = new Set();
const __shareWasiAddonCrashFlag = () => {};
const startupListeners = {};
const startupWorker = {
  addEventListener(name, listener) { startupListeners[name] = listener; },
};
function createStartupWorker() {
      const worker = startupWorker;
      __wasiWorkers.add(worker);
      __shareWasiAddonCrashFlag(worker);

      return worker;
}
createStartupWorker();
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
        failWorkerStartup(error) { startupListeners.error({ error }); },
        runPollTimer() { const callback = timers.values().next().value; timers.delete(callback); callback(); },
        timerCount: () => timers.size,
        terminated: () => terminated,
      };`,
    )();
    const initialization = fixture.failInitialization();
    expect(fixture.timerCount()).toBe(1);
    fixture.failWorkerStartup(
      new Error("static import failed"),
    );
    fixture.runPollTimer();

    // oxlint-disable-next-line typescript/await-thenable, typescript/no-confusing-void-expression -- The generated fixture's dynamically constructed initialization value is intentionally untyped.
    await expect(initialization).rejects.toThrow(
      "initialization failed",
    );
    expect(fixture.terminated()).toBe(1);
    expect(fixture.timerCount()).toBe(0);
  });

  test("skips context destruction when rollback crashes during settlement draining", async () => {
    const generated = `
let __wasiAddonCrashFlag;
let __wasiDisposePromise;
let destroyed = 0;
let terminated = 0;
const timers = new Set();
const __isThenable = (value) => value && typeof value.then === "function";
const __terminateWasiWorkers = () => { terminated += 1; };
const __retainFailedWasiRollback = (errors) => errors;
const __drainWasiAsyncWork = () => {};
const __prepareWasmEnvCleanupWithTurns = () => {};
const __drainWasmEnvCleanup = () => new Promise((resolve) => { timers.add(resolve); });
const __destroyEmnapiContext = () => { destroyed += 1; };
const __finishWasiInitializationRollback = (errors) => errors;
function __destroyContextForWasiRollback(cleanupErrors) {
  let destroyResult;
  try {
    destroyResult = __destroyEmnapiContext();
  } catch (cleanupError) {
    cleanupErrors.push(cleanupError);
    return __finishWasiInitializationRollback(cleanupErrors);
  }
  if (__isThenable(destroyResult)) return Promise.resolve(destroyResult).then(() => __finishWasiInitializationRollback(cleanupErrors));
  return __finishWasiInitializationRollback(cleanupErrors);
}
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
        destroyed: () => destroyed,
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
    // oxlint-disable-next-line typescript/await-thenable, typescript/no-confusing-void-expression -- The generated fixture's dynamically constructed initialization value is intentionally untyped.
    await expect(initialization).rejects.toHaveProperty(
      "cause.message",
      "napi-rs: WASI binding cannot be disposed after a worker thread crashed",
    );
    expect(fixture.destroyed()).toBe(0);
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
