# stella-regex-set-core

Rust-native multi-pattern regex search used by
[`@stll/regex-set`](https://www.npmjs.com/package/@stll/regex-set).
It combines backtracking-free automata with a bounded compatibility fallback,
prepared search artifacts, UTF-16 or byte offsets, and Unicode word boundaries.

## Example

```rust
use stella_regex_set_core::{Options, RegexSet};

let search = RegexSet::new(
    vec![String::from(r"\d{4}-\d{2}-\d{2}"), String::from("contract")],
    Options::default(),
)?;

assert!(search.is_match("signed 2026-08-12"));

# Ok::<(), stella_regex_set_core::Error>(())
```

The JavaScript package remains the primary distribution for Node.js, Bun, and
WASM consumers. This crate is the reusable Rust core and contains no N-API
bindings.

## Licence

MIT
