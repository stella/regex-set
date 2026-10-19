import type { NativeBinding } from "./core";
import type { WasmExports } from "./single-thread-runtime";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const REINITIALIZE =
  "The single-thread WebAssembly instance trapped; call init() or initSync() again";

type Reply = {
  ok: boolean;
  value?: unknown;
  error?: string;
};

export const createSingleThreadBinding = (
  wasm: WasmExports,
  onTrap: () => void,
): NativeBinding => {
  let trapped = false;

  const request = (body: object): unknown => {
    if (trapped) throw new Error(REINITIALIZE);
    const bytes = encoder.encode(JSON.stringify(body));
    try {
      const pointer = wasm.alloc(bytes.length);
      new Uint8Array(
        wasm.memory.buffer,
        pointer,
        bytes.length,
      ).set(bytes);
      wasm.dispatch(pointer, bytes.length);
      const output = new Uint8Array(
        wasm.memory.buffer,
        wasm.output_pointer(),
        wasm.output_length(),
      );
      const reply: Reply = JSON.parse(
        decoder.decode(output),
      );
      if (!reply.ok)
        throw new Error(
          reply.error ?? "WASM operation failed",
        );
      return reply.value;
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) {
        trapped = true;
        onTrap();
      }
      throw error;
    }
  };

  const numbers = (value: unknown): number[] => {
    if (
      !Array.isArray(value) ||
      !value.every(Number.isInteger)
    ) {
      throw new TypeError(
        "Invalid numeric response from single-thread WebAssembly",
      );
    }
    return value;
  };
  const bytes = (value: Uint8Array) => [...value];
  const options = (
    opts?: {
      wholeWords?: boolean;
      unicodeBoundaries?: boolean;
    } | null,
  ) => ({
    whole_words: opts?.wholeWords ?? false,
    unicode_boundaries: opts?.unicodeBoundaries ?? true,
  });

  class WasmRegexSet {
    readonly handle: number;
    readonly patternCount: number;
    constructor(
      patterns: string[],
      opts?: {
        wholeWords?: boolean;
        unicodeBoundaries?: boolean;
      } | null,
      prepared?: Uint8Array | null,
    ) {
      this.patternCount = patterns.length;
      const value = request({
        op: "create",
        patterns,
        ...options(opts),
        prepared: prepared ? bytes(prepared) : null,
      });
      if (!Number.isInteger(value))
        throw new TypeError(
          "Invalid matcher handle from single-thread WebAssembly",
        );
      this.handle = Number(value);
      finalizers.register(this, this.handle);
    }
    _enginePathCounts() {
      return Uint32Array.from(
        numbers(
          request({ op: "counts", handle: this.handle }),
        ),
      );
    }
    isMatch(haystack: string) {
      return Boolean(
        request({
          op: "is_match",
          handle: this.handle,
          haystack,
        }),
      );
    }
    _isMatchBuf(haystack: Uint8Array) {
      return Boolean(
        request({
          op: "is_match_buf",
          handle: this.handle,
          haystack: bytes(haystack),
        }),
      );
    }
    _findIterPacked(haystack: string) {
      return Uint32Array.from(
        numbers(
          request({
            op: "find",
            handle: this.handle,
            haystack,
          }),
        ),
      );
    }
    _findIterPackedBuf(haystack: Uint8Array) {
      return Uint32Array.from(
        numbers(
          request({
            op: "find_buf",
            handle: this.handle,
            haystack: bytes(haystack),
          }),
        ),
      );
    }
    whichMatch(haystack: string) {
      return numbers(
        request({
          op: "which",
          handle: this.handle,
          haystack,
        }),
      );
    }
    replaceAll(haystack: string, replacements: string[]) {
      const value = request({
        op: "replace",
        handle: this.handle,
        haystack,
        replacements,
      });
      if (typeof value !== "string")
        throw new TypeError(
          "Invalid replacement response from single-thread WebAssembly",
        );
      return value;
    }
  }

  const finalizers = new FinalizationRegistry<number>(
    (handle) => {
      if (!trapped) request({ op: "free", handle });
    },
  );

  return {
    RegexSet: WasmRegexSet,
    _prepareRegexSet(patterns, opts) {
      return Uint8Array.from(
        numbers(
          request({
            op: "prepare",
            patterns,
            ...options(opts),
          }),
        ),
      );
    },
    _uax29Boundaries(haystack) {
      return numbers(
        request({
          op: "boundaries",
          haystack: bytes(haystack),
        }),
      );
    },
  };
};
