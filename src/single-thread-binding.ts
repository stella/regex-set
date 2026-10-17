import type { NativeBinding } from "./core";

const OP = {
  new: 1,
  prepare: 2,
  fromPrepared: 3,
  patternCount: 4,
  isMatch: 5,
  findIter: 6,
  replaceAll: 8,
  findIterBuf: 9,
  isMatchBuf: 10,
  free: 16,
  whichMatch: 17,
  uax29Boundaries: 18,
} as const;

const number = (value: unknown): number => {
  if (typeof value !== "number")
    throw new Error("Invalid numeric WASM response");
  return value;
};

// TextEncoder.encodeInto writes directly into the allocated linear-memory view.
// Count UTF-8 bytes first so ASCII inputs reserve one byte per code unit.
const utf8Length = (text: string): number => {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 &&
      text.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
};

const optionFlags = (
  options?: Record<string, unknown>,
): number => {
  let flags = 0;
  for (const [name, bit] of [
    ["wholeWords", 8],
    ["unicodeBoundaries", 16],
  ] as const) {
    const value = options?.[name];
    if (value !== undefined && typeof value !== "boolean")
      throw new Error(`${name} must be a boolean`);
    if (
      name === "unicodeBoundaries"
        ? value === false
        : value === true
    )
      flags |= bit;
  }
  return flags;
};

type Request = {
  id?: number;
  options?: Record<string, unknown>;
  strings?: readonly string[];
  bytes?: Uint8Array;
};

const scalar = (bytes: Uint8Array): number => {
  if (bytes.byteLength !== 4)
    throw new Error("Invalid scalar WASM response");
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    4,
  ).getUint32(0, true);
};
const packed = (bytes: Uint8Array): Uint32Array => {
  if (bytes.byteLength % 4 !== 0)
    throw new Error("Invalid packed WASM response");
  const result = new Uint32Array(bytes.byteLength / 4);
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  for (let i = 0; i < result.length; i++)
    result[i] = view.getUint32(i * 4, true);
  return result;
};
/** Binary transport only; matching and options use the shared Rust core. */
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
    op: number,
    { id = 0, options, strings = [], bytes }: Request = {},
  ): Uint8Array => {
    const lengths = new Uint32Array(strings.length);
    let size = 16 + (bytes?.byteLength ?? 0);
    for (const [i, text] of strings.entries()) {
      const length = utf8Length(text);
      if (length > 0xffffffff)
        throw new RangeError("WASM string is too large");
      lengths[i] = length;
      size += 4 + length;
    }
    if (size > 0xffffffff)
      throw new RangeError("WASM request is too large");
    const flags = optionFlags(options);
    // A caller of this low-level adapter can supply a view of its own memory.
    // Preserve it across allocation/growth; public prepared results are copies.
    if (bytes?.buffer === memory.buffer)
      bytes = Uint8Array.from(bytes);
    const pointer = number(allocate(size)) >>> 0;
    const view = new DataView(memory.buffer, pointer, size);
    view.setUint32(0, op, true);
    view.setUint32(4, id, true);
    view.setUint32(8, flags, true);
    view.setUint32(12, strings.length, true);
    let cursor = 16;
    for (const [i, text] of strings.entries()) {
      const length = number(lengths[i]);
      view.setUint32(cursor, length, true);
      cursor += 4;
      const written = encoder.encodeInto(
        text,
        new Uint8Array(
          memory.buffer,
          pointer + cursor,
          length,
        ),
      );
      if (
        written.read !== text.length ||
        written.written !== length
      )
        throw new Error("Incomplete WASM string encoding");
      cursor += length;
    }
    if (bytes)
      new Uint8Array(
        memory.buffer,
        pointer + cursor,
        bytes.byteLength,
      ).set(bytes);
    const status = number(run());
    const output = new Uint8Array(
      memory.buffer,
      number(outputPointer()) >>> 0,
      number(outputLength()) >>> 0,
    );
    if (status !== 0)
      throw new Error(decoder.decode(output));
    return output;
  };
  const registry = new FinalizationRegistry<number>(
    (id) => {
      call(OP.free, { id });
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
      this.id = scalar(
        call(prepared ? OP.fromPrepared : OP.new, {
          strings: patterns,
          options: options ?? undefined,
          bytes: prepared ?? undefined,
        }),
      );
      registry.register(this, this.id);
    }
    get patternCount() {
      return scalar(call(OP.patternCount, { id: this.id }));
    }
    isMatch(haystack: string) {
      return (
        scalar(
          call(OP.isMatch, {
            id: this.id,
            strings: [haystack],
          }),
        ) !== 0
      );
    }
    _isMatchBuf(bytes: Uint8Array) {
      return (
        scalar(
          call(OP.isMatchBuf, { id: this.id, bytes }),
        ) !== 0
      );
    }
    _findIterPacked(haystack: string) {
      return packed(
        call(OP.findIter, {
          id: this.id,
          strings: [haystack],
        }),
      );
    }
    _findIterPackedBuf(bytes: Uint8Array) {
      return packed(
        call(OP.findIterBuf, { id: this.id, bytes }),
      );
    }
    whichMatch(haystack: string) {
      return [
        ...packed(
          call(OP.whichMatch, {
            id: this.id,
            strings: [haystack],
          }),
        ),
      ];
    }
    replaceAll(haystack: string, replacements: string[]) {
      return decoder.decode(
        call(OP.replaceAll, {
          id: this.id,
          strings: [haystack, ...replacements],
        }),
      );
    }
  }
  return {
    RegexSet: Matcher,
    _prepareRegexSet: (patterns, options) =>
      call(OP.prepare, {
        strings: patterns,
        options: options ?? undefined,
      }).slice(),
    _uax29Boundaries: (bytes) => [
      ...packed(call(OP.uax29Boundaries, { bytes })),
    ],
  };
};
