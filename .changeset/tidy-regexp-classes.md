---
"@stll/regex-set": patch
"@stll/regex-set-wasm": patch
---

Preserve JavaScript RegExp whitespace, word classes, word boundaries, and escaped backslashes during translation. Unicode RegExp word boundaries use JavaScript word membership independently of the engine boundary option, including Kelvin sign and long-s folding for `/iu`.
