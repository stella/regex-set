/**
 * Typed reads of parsed repository documents (JSON, YAML and TOML) in tests.
 * The parsers return `unknown`; these helpers narrow a value or throw a
 * TypeError naming its path, so a changed document reports where it changed.
 */
export type Mapping = Readonly<Record<string, unknown>>;

const isMapping = (value: unknown): value is Mapping =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const mapping = (value: unknown, label: string): Mapping => {
  if (!isMapping(value)) throw new TypeError(`${label} must be a mapping`);
  return value;
};

export const list = (value: unknown, label: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be a list`);
  return value;
};

export const text = (value: unknown, label: string): string => {
  if (typeof value !== "string")
    throw new TypeError(`${label} must be a string`);
  return value;
};

/** Follows mapping keys; a missing final key yields `undefined`. */
export const at = (value: unknown, ...keys: string[]): unknown => {
  let current = value;
  for (const [index, key] of keys.entries()) {
    const label = index === 0 ? "document" : keys.slice(0, index).join(".");
    current = mapping(current, label)[key];
  }
  return current;
};

/** Parses JSON text without letting `any` escape. */
export const parseJson = (source: string): unknown => JSON.parse(source);
