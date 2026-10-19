declare namespace WebAssembly {
  type Instance = {
    readonly exports: Record<string, unknown>;
  };

  type Memory = {
    readonly buffer: ArrayBuffer;
  };

  type Module = object;
}

declare var WebAssembly: {
  Instance: new (
    module: WebAssembly.Module,
    imports?: Record<string, Record<string, unknown>>,
  ) => WebAssembly.Instance;
  Memory: new (descriptor: {
    initial: number;
    maximum?: number;
  }) => WebAssembly.Memory;
  Module: new (
    source: ArrayBuffer | ArrayBufferView,
  ) => WebAssembly.Module;
  RuntimeError: new (message?: string) => Error;
  instantiate(
    source: ArrayBuffer | ArrayBufferView,
    imports?: Record<string, Record<string, unknown>>,
  ): Promise<{
    instance: WebAssembly.Instance;
    module: WebAssembly.Module;
  }>;
};
