const suppressionComment =
  /^\s*(?:\/\/|\/\*)\s*(?:eslint-(?:disable|enable)|oxlint-(?:disable|enable)|@ts-(?:ignore|expect-error|nocheck)|prettier-ignore)\b.*?(?:\*\/)?\s*\r?\n/gim;

export const normalizeGeneratedLoader = (content) =>
  content
    .replace(suppressionComment, "")
    .replace(/[ \t]+$/gm, "");
