use napi::bindgen_prelude::*;
use napi_derive::napi;
use regex_automata::meta::Regex;

/// Options for constructing a `RegexSet`.
#[napi(object)]
pub struct Options {
  /// Only match whole words. Default: `false`.
  /// Wraps each pattern with `\b...\b`.
  pub whole_words: Option<bool>,
}

/// A single match returned by search methods.
#[napi(object)]
pub struct Match {
  /// Index of the pattern that matched.
  pub pattern: u32,
  /// Start offset (UTF-16 code units).
  pub start: u32,
  /// End offset (exclusive, UTF-16 code units).
  pub end: u32,
}

// ─── UTF-16 offset translation ────────────────

fn byte_span_utf16_len(bytes: &[u8]) -> u32 {
  let mut count = 0u32;
  let mut i = 0;
  while i < bytes.len() {
    let b = bytes[i];
    if b < 0x80 {
      count += 1;
      i += 1;
    } else if b < 0xE0 {
      count += 1;
      i += 2;
    } else if b < 0xF0 {
      count += 1;
      i += 3;
    } else {
      count += 2;
      i += 4;
    }
  }
  count
}

// ─── RegexSet ─────────────────────────────────

/// Multi-pattern regex matcher.
///
/// Wraps Rust's `regex-automata` crate. All patterns
/// are compiled into a single automaton and searched
/// in one pass. Guaranteed O(m * n) where m is the
/// number of patterns and n is the haystack length.
/// No catastrophic backtracking.
#[napi]
pub struct RegexSet {
  inner: Regex,
  pattern_count: u32,
}

#[napi]
impl RegexSet {
  /// Build a multi-pattern regex matcher.
  ///
  /// Patterns use Rust regex syntax (similar to
  /// PCRE but no backreferences or lookaround).
  #[napi(constructor)]
  pub fn new(
    patterns: Vec<String>,
    options: Option<Options>,
  ) -> Result<Self> {
    let whole_words = options
      .and_then(|o| o.whole_words)
      .unwrap_or(false);

    let pattern_count = patterns.len() as u32;

    // wholeWords: wrap each pattern with \b
    let wrapped: Vec<String> = if whole_words {
      patterns
        .iter()
        .map(|p| format!("\\b(?:{p})\\b"))
        .collect()
    } else {
      patterns
    };

    let refs: Vec<&str> =
      wrapped.iter().map(|s| s.as_str()).collect();
    let inner =
      Regex::new_many(&refs).map_err(|e| {
        Error::from_reason(format!(
          "Failed to compile regex: {e}"
        ))
      })?;

    Ok(Self {
      inner,
      pattern_count,
    })
  }

  /// Number of patterns.
  #[napi(getter)]
  pub fn pattern_count(&self) -> u32 {
    self.pattern_count
  }

  /// Returns `true` if any pattern matches.
  #[napi]
  pub fn is_match(&self, haystack: String) -> bool {
    self.inner.is_match(&haystack)
  }

  /// Find all non-overlapping matches. Returns a
  /// packed `Uint32Array` of `[pattern, start, end]`
  /// triples.
  #[napi(js_name = "_findIterPacked")]
  pub fn find_iter_packed(
    &self,
    haystack: String,
  ) -> Uint32Array {
    if haystack.is_ascii() {
      let mut packed = Vec::new();
      for m in self.inner.find_iter(&haystack) {
        packed.push(m.pattern().as_u32());
        packed.push(m.start() as u32);
        packed.push(m.end() as u32);
      }
      return Uint32Array::new(packed);
    }

    let bytes = haystack.as_bytes();
    let mut packed = Vec::new();
    let mut last_byte: usize = 0;
    let mut last_utf16: u32 = 0;

    for m in self.inner.find_iter(&haystack) {
      last_utf16 += byte_span_utf16_len(
        &bytes[last_byte..m.start()],
      );
      let start = last_utf16;
      last_byte = m.start();

      last_utf16 += byte_span_utf16_len(
        &bytes[last_byte..m.end()],
      );
      let end = last_utf16;
      last_byte = m.end();

      packed.push(m.pattern().as_u32());
      packed.push(start);
      packed.push(end);
    }
    Uint32Array::new(packed)
  }

  /// Find which patterns match (not where).
  /// Returns an array of pattern indices.
  #[napi]
  pub fn which_match(
    &self,
    haystack: String,
  ) -> Vec<u32> {
    let mut seen = vec![false; self.pattern_count as usize];
    let mut result = Vec::new();
    for m in self.inner.find_iter(&haystack) {
      let idx = m.pattern().as_u32();
      if !seen[idx as usize] {
        seen[idx as usize] = true;
        result.push(idx);
      }
    }
    result
  }

  /// Replace all non-overlapping matches.
  ///
  /// `replacements[i]` replaces pattern `i`.
  #[napi]
  pub fn replace_all(
    &self,
    haystack: String,
    replacements: Vec<String>,
  ) -> Result<String> {
    if replacements.len()
      != self.pattern_count as usize
    {
      return Err(Error::from_reason(format!(
        "Expected {} replacements, got {}",
        self.pattern_count,
        replacements.len()
      )));
    }

    let mut result = String::with_capacity(
      haystack.len(),
    );
    let mut last = 0;
    for m in self.inner.find_iter(&haystack) {
      result.push_str(&haystack[last..m.start()]);
      result.push_str(
        &replacements[m.pattern().as_usize()],
      );
      last = m.end();
    }
    result.push_str(&haystack[last..]);
    Ok(result)
  }
}
