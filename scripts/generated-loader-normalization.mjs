const suppressionComment =
  /^\s*(?:\/\/|\/\*)\s*(?:eslint-(?:disable|enable)|oxlint-(?:disable|enable)|@ts-(?:ignore|expect-error|nocheck)|prettier-ignore)\b.*?(?:\*\/)?\s*\r?\n/gim;

/** @param {string} content */
const normalizeBrowserCrashDisposal = (content) => {
  if (!content.includes("let __wasiAddonCrashFlag;")) {
    return content;
  }
  if (content.includes("function __hasWasiThreadCrashed()")) {
    return content.replace(
      "  try {\n    live = begin();",
      "  try {\n    __abortWasiDisposalIfThreadCrashed();\n    live = begin();",
    );
  }

  return content
    .replace(
      "let __wasiDisposePromise;",
      `let __wasiDisposePromise;
let __wasiThreadCrashDisposePromise;
let __wasiInitializationRollbackActive = false;
let __wasiThreadCrashed = false;
let __wasiThreadCrashWorkerError;

function __recordWasiThreadCrashError(error) {
  __wasiThreadCrashed = true;
  if (
    __wasiThreadCrashWorkerError === undefined &&
    error !== undefined
  ) {
    __wasiThreadCrashWorkerError = error;
  }
}

function __hasWasiThreadCrashed() {
  if (
    __wasiThreadCrashed ||
    (__wasiAddonCrashFlag !== undefined &&
      Atomics.load(__wasiAddonCrashFlag, 0) !== 0)
  ) {
    return true;
  }
  const manager =
    typeof __getWasiThreadManager === "function"
      ? __getWasiThreadManager()
      : undefined;
  return Boolean(manager && manager._fatalError);
}

function __getWasiThreadCrashError() {
  const error = new Error(
    "napi-rs: WASI binding cannot be disposed after a worker thread crashed",
  );
  const manager =
    typeof __getWasiThreadManager === "function"
      ? __getWasiThreadManager()
      : undefined;
  const cause =
    __wasiThreadCrashWorkerError ??
    (manager ? manager._fatalError : undefined);
  if (cause !== undefined && cause !== null) {
    error.cause = cause;
  }
  return error;
}

function __disposeWasiBindingAfterThreadCrash() {
  if (__wasiThreadCrashDisposePromise) {
    return __wasiThreadCrashDisposePromise;
  }
  let workerResult;
  try {
    workerResult = __terminateWasiWorkers();
  } catch (error) {
    workerResult = Promise.reject(error);
  }
  __wasiThreadCrashDisposePromise = Promise.resolve(workerResult).then(
    () => {
      throw __getWasiThreadCrashError();
    },
    (error) => {
      throw error;
    },
  );
  return __wasiThreadCrashDisposePromise;
}

function __abortWasiDisposalIfThreadCrashed() {
  if (
    (__wasiDisposePromise !== undefined ||
      __wasiInitializationRollbackActive) &&
    __hasWasiThreadCrashed()
  ) {
    throw __getWasiThreadCrashError();
  }
}

function __settleWasiDisposalAfterThreadCrash(resolve, reject) {
  if (!__hasWasiThreadCrashed()) {
    return false;
  }
  __disposeWasiBindingAfterThreadCrash().then(resolve, reject);
  return true;
}

function __rollbackWasiInitializationAfterThreadCrash() {
  const crashError = __getWasiThreadCrashError();
  void __disposeWasiBindingAfterThreadCrash().catch(() => {});
  return [crashError];
}`,
    )
    .replace(
      `      __wasiWorkers.add(worker);
      __shareWasiAddonCrashFlag(worker);`,
      `      __wasiWorkers.add(worker);
      worker.addEventListener("error", (event) => {
        __recordWasiThreadCrashError(event.error ?? event);
      });
      worker.addEventListener("messageerror", (event) => {
        __recordWasiThreadCrashError(event);
      });
      __shareWasiAddonCrashFlag(worker);`,
    )
    .replace(
      `  __finishParkedWasmEnvCleanup = finishCleanup;
  return (async () => {`,
      `  __finishParkedWasmEnvCleanup = finishCleanup;
  const finishCleanupUnlessCrashed = () => {
    try {
      __abortWasiDisposalIfThreadCrashed();
    } catch (error) {
      __finishParkedWasmEnvCleanup = undefined;
      throw error;
    }
    finishCleanup();
  };
  return (async () => {`,
    )
    .replace(
      "  try {\n    live = begin();",
      "  try {\n    __abortWasiDisposalIfThreadCrashed();\n    live = begin();",
    )
    .replace(
      "  })().then(finishCleanup, finishCleanup);",
      `  })().then(
    finishCleanupUnlessCrashed,
    finishCleanupUnlessCrashed,
  );`,
    )
    .replace(
      "await __yieldWasmRuntimePollTurn(pace);\n      try {",
      "await __yieldWasmRuntimePollTurn(pace);\n      __abortWasiDisposalIfThreadCrashed();\n      try {",
    )
    .replace(
      `          );
        });
      }
    })(),`,
      `          );
        });
        __abortWasiDisposalIfThreadCrashed();
      }
    })(),`,
    )
    .replace(
      "function __continueWasiDisposal() {\n  const destroyResult",
      "function __continueWasiDisposal() {\n  __abortWasiDisposalIfThreadCrashed();\n  const destroyResult",
    )
    .replace(
      "function __destroyContextForWasiRollback(cleanupErrors) {\n  let destroyResult",
      "function __destroyContextForWasiRollback(cleanupErrors) {\n  __abortWasiDisposalIfThreadCrashed();\n  let destroyResult",
    )
    .replace(
      "function __drainWasmEnvForWasiDisposal() {\n  const drainResult",
      "function __drainWasmEnvForWasiDisposal() {\n  __abortWasiDisposalIfThreadCrashed();\n  const drainResult",
    )
    .replace(
      "function __cleanUpWasmEnvForWasiDisposal() {",
      "function __cleanUpWasmEnvForWasiDisposal() {\n  __abortWasiDisposalIfThreadCrashed();",
    )
    .replace(
      "function __rollbackWasiInitialization() {",
      "function __runWasiInitializationRollbackSteps() {",
    )
    .replace(
      "  function __rollbackWasmEnvForWasiInitialization() {\n    const cleanupErrors",
      "  function __rollbackWasmEnvForWasiInitialization() {\n    __abortWasiDisposalIfThreadCrashed();\n    const cleanupErrors",
    )
    .replace(
      "  function __drainWasmEnvForWasiRollback(cleanupErrors) {\n    let drainResult",
      "  function __drainWasmEnvForWasiRollback(cleanupErrors) {\n    __abortWasiDisposalIfThreadCrashed();\n    let drainResult",
    )
    .replace(
      "\n// A view of the addon's crash flag, one word of the shared wasm memory, for the",
      `
function __rollbackWasiInitialization() {
  if (__hasWasiThreadCrashed()) {
    return __rollbackWasiInitializationAfterThreadCrash();
  }
  __wasiInitializationRollbackActive = true;
  let result;
  try {
    result = __runWasiInitializationRollbackSteps();
  } catch (error) {
    __wasiInitializationRollbackActive = false;
    if (__hasWasiThreadCrashed()) {
      return __rollbackWasiInitializationAfterThreadCrash();
    }
    throw error;
  }
  if (!__isThenable(result)) {
    __wasiInitializationRollbackActive = false;
    return __hasWasiThreadCrashed()
      ? __rollbackWasiInitializationAfterThreadCrash()
      : result;
  }
  return Promise.resolve(result).then(
    (cleanupErrors) => {
      __wasiInitializationRollbackActive = false;
      return __hasWasiThreadCrashed()
        ? __rollbackWasiInitializationAfterThreadCrash()
        : cleanupErrors;
    },
    (error) => {
      __wasiInitializationRollbackActive = false;
      if (__hasWasiThreadCrashed()) {
        return __rollbackWasiInitializationAfterThreadCrash();
      }
      throw error;
    },
  );
}

// A view of the addon's crash flag, one word of the shared wasm memory, for the`,
    )
    .replace(
      `  if (__wasiDisposed) {
    return Promise.resolve();
  }`,
      `  if (!__wasiDisposed && __hasWasiThreadCrashed()) {
    return __disposeWasiBindingAfterThreadCrash();
  }
  if (__wasiDisposed) {
    return Promise.resolve();
  }`,
    )
    .replace(
      `  } catch (error) {
    __wasiDisposePromise = undefined;
    rejectDispose(error);
    return disposePromise;
  }

  Promise.resolve(result).then(`,
      `  } catch (error) {
    if (__settleWasiDisposalAfterThreadCrash(resolveDispose, rejectDispose)) {
      return disposePromise;
    }
    __wasiDisposePromise = undefined;
    rejectDispose(error);
    return disposePromise;
  }

  Promise.resolve(result).then(`,
    )
    .replace(
      `    (error) => {
      __wasiDisposePromise = undefined;
      rejectDispose(error);
    },
  );
  return disposePromise;`,
      `    (error) => {
      if (__settleWasiDisposalAfterThreadCrash(resolveDispose, rejectDispose)) {
        return;
      }
      __wasiDisposePromise = undefined;
      rejectDispose(error);
    },
  );
  return disposePromise;`,
    );
};

/** @param {string} content */
const normalizeCleanupCrashChecks = (content) =>
  content
    .replace(
      "function __prepareWasmEnvCleanup() {\n  if (",
      "function __prepareWasmEnvCleanup() {\n  __abortWasiDisposalIfThreadCrashed();\n  if (",
    )
    .replace(
      "  const finishCleanup = () => {\n    if (",
      "  const finishCleanup = () => {\n    __abortWasiDisposalIfThreadCrashed();\n    if (",
    )
    .replace(
      "function __destroyEmnapiContext() {\n  if (",
      "function __destroyEmnapiContext() {\n  __abortWasiDisposalIfThreadCrashed();\n  if (",
    )
    .replace(
      "      value: function () {\n        // Reentered",
      "      value: function () {\n        __abortWasiDisposalIfThreadCrashed();\n        // Reentered",
    );

/** @param {string} content */
export const normalizeGeneratedLoader = (content) =>
  normalizeCleanupCrashChecks(normalizeBrowserCrashDisposal(content))
    .replace(suppressionComment, "")
    .replace('| "wasm32-wasip1";', '| "wasm32-wasip1"\n  | undefined;')
    .replace(/[ \t]+$/gm, "");
