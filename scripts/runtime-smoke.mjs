import assert from "node:assert/strict";

import { RegexSet } from "../dist/index.mjs";

const rs = new RegexSet([
  "\\d{2}\\.\\d{2}\\.\\d{4}",
  "\\+?\\d{9,12}",
  "[A-Z]{2}\\d{6}",
  { pattern: "(?<!\\p{L})IČO:\\s*[0-9]{8}", name: "company-id" },
]);

const haystack =
  "Born 15.03.1990, phone +420123456789, ID CZ123456, IČO: 12345678";

const matches = rs.findIter(haystack);

assert.equal(rs.patternCount, 4);
assert.equal(rs.isMatch(haystack), true);
assert.deepEqual(rs.whichMatch(haystack), [0, 1, 2, 3]);
assert.deepEqual(
  matches.map((m) => m.text),
  ["15.03.1990", "+420123456789", "CZ123456", "IČO: 12345678"],
);
assert.equal(matches[3]?.name, "company-id");

const replaced = rs.replaceAll(haystack, [
  "[DATE]",
  "[PHONE]",
  "[ID]",
  "[COMPANY]",
]);
assert.equal(
  replaced,
  "Born [DATE], phone [PHONE], ID [ID], [COMPANY]",
);

console.log("runtime smoke ok");
