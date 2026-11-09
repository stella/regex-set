---
"@stll/regex-set": patch
---

Update fancy-regex to 0.20 for patterns that need lookaround or backreferences. In Unicode mode, `\xHH` escapes above `0x7F` now match the code point, as they already did for the other patterns; case-insensitive prefilters no longer miss candidates for non-ASCII class ranges.
