import type { NativeBinding } from "./core";

const numbers = (value: unknown): number[] => {
  if (
    !Array.isArray(value) ||
    !value.every(
      (item: unknown) => typeof item === "number",
    )
  )
    throw new Error("Invalid numeric WASM response");
  return value;
};
const number = (value: unknown): number => {
  if (typeof value !== "number")
    throw new Error("Invalid WASM handle");
  return value;
};
const boolean = (value: unknown): boolean => {
  if (typeof value !== "boolean")
    throw new Error("Invalid boolean WASM response");
  return value;
};
const string = (value: unknown): string => {
  if (typeof value !== "string")
    throw new Error("Invalid string WASM response");
  return value;
};

/** Transport only; patterns and matching use the shared public wrapper and Rust core. */
export const createSingleThreadBinding = (
  exports: WebAssembly.Exports,
): NativeBinding => {
  const {
    memory,
    regex_input_alloc: allocate,
    regex_run: run,
    regex_output_ptr: outputPointer,
    regex_output_len: outputLength,
  } = exports;
  if (
    !(memory instanceof WebAssembly.Memory) ||
    typeof allocate !== "function" ||
    typeof run !== "function" ||
    typeof outputPointer !== "function" ||
    typeof outputLength !== "function"
  )
    throw new Error("Invalid single-thread WASM module");
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const call = (
    op: string,
    fields: Record<string, unknown> = {},
  ): unknown => {
    const input = encoder.encode(
      JSON.stringify({ op, ...fields }),
    );
    const pointer = number(allocate(input.length));
    new Uint8Array(
      memory.buffer,
      pointer,
      input.length,
    ).set(input);
    run();
    const response: unknown = JSON.parse(
      decoder.decode(
        new Uint8Array(
          memory.buffer,
          number(outputPointer()),
          number(outputLength()),
        ),
      ),
    );
    if (typeof response !== "object" || response === null)
      throw new Error("Invalid WASM response");
    if ("error" in response)
      throw new Error(string(response.error));
    if (!("value" in response))
      throw new Error("Missing WASM response");
    return response.value;
  };
  const registry = new FinalizationRegistry<number>(
    (id) => {
      call("free", { id });
    },
  );
  class Matcher {
    private readonly id: number;
    constructor(
      patterns: string[],
      options?: {
        wholeWords?: boolean;
        unicodeBoundaries?: boolean;
      } | null,
      prepared?: Uint8Array | null,
    ) {
      this.id = number(
        call(prepared ? "fromPrepared" : "new", {
          patterns,
          options: options ?? undefined,
          ...(prepared
            ? { bytes: Array.from(prepared) }
            : {}),
        }),
      );
      registry.register(this, this.id);
    }
    get patternCount() {
      return number(call("patternCount", { id: this.id }));
    }
    isMatch(haystack: string) {
      return boolean(
        call("isMatch", { id: this.id, haystack }),
      );
    }
    _isMatchBuf(bytes: Uint8Array) {
      return boolean(
        call("isMatchBuf", {
          id: this.id,
          bytes: Array.from(bytes),
        }),
      );
    }
    _findIterPacked(haystack: string) {
      return Uint32Array.from(
        numbers(
          call("findIter", { id: this.id, haystack }),
        ),
      );
    }
    _findIterPackedBuf(bytes: Uint8Array) {
      return Uint32Array.from(
        numbers(
          call("findIterBuf", {
            id: this.id,
            bytes: Array.from(bytes),
          }),
        ),
      );
    }
    whichMatch(haystack: string) {
      return numbers(
        call("whichMatch", { id: this.id, haystack }),
      );
    }
    replaceAll(haystack: string, replacements: string[]) {
      return string(
        call("replaceAll", {
          id: this.id,
          haystack,
          replacements,
        }),
      );
    }
  }
  return {
    RegexSet: Matcher,
    _prepareRegexSet: (patterns, options) =>
      Uint8Array.from(
        numbers(
          call("prepare", {
            patterns,
            options: options ?? undefined,
          }),
        ),
      ),
    _uax29Boundaries: (bytes) =>
      numbers(
        call("uax29Boundaries", {
          bytes: Array.from(bytes),
        }),
      ),
  };
};
