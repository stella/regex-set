use napi::bindgen_prelude::*;
use napi_derive::napi;
use regex_automata::meta::Regex as MetaRegex;

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

// ─── Lookaround handling ──────────────────────
//
// Strategy: strip lookaround from patterns, add
// the "core" to the multi-DFA, then verify the
// assertion as a post-filter. This keeps all
// patterns on the fast single-pass path.
//
// Simple assertions (single char class after/before
// the match) are verified as direct char checks.
// Complex assertions fall back to fancy-regex on
// a small window around the match.

/// Strip simple lookaround from a pattern and
/// return (core_pattern, pre_check, post_check).
///
/// Handles:
/// - `(?!\X)` at end → post-check: next char doesn't match X
/// - `(?<!\X)` at start → pre-check: prev char doesn't match X
/// - `(?=\X)` at end → post-check: next char matches X
/// - `(?<=\X)` at start → pre-check: prev char matches X
///
/// Returns None if the pattern has no lookaround
/// or if the lookaround is too complex to strip.
struct StrippedPattern {
  core: String,
  verifier: Option<fancy_regex::Regex>,
  original_index: usize,
}

fn has_lookaround(pattern: &str) -> bool {
  pattern.contains("(?=")
    || pattern.contains("(?!")
    || pattern.contains("(?<=")
    || pattern.contains("(?<!")
}

/// Try to strip lookaround and produce a core
/// pattern for the multi-DFA + a fancy-regex
/// verifier for post-filtering.
fn strip_lookaround(
  pattern: &str,
  idx: usize,
) -> std::result::Result<StrippedPattern, String> {
  if !has_lookaround(pattern) {
    return Ok(StrippedPattern {
      core: pattern.to_string(),
      verifier: None,
      original_index: idx,
    });
  }

  let verifier = fancy_regex::Regex::new(pattern)
    .map_err(|e| {
      format!("Failed to compile pattern {idx}: {e}")
    })?;

  // Strip lookaround for the core by removing
  // (?=...), (?!...), (?<=...), (?<!...) groups.
  // This is a simple string-level strip that
  // handles the common patterns. Complex nested
  // lookaround falls back to the full fancy-regex.
  let core = strip_lookaround_str(pattern);

  // Verify the core compiles with regex-automata.
  if MetaRegex::new(&core).is_err() {
    // Core doesn't compile (complex pattern).
    // Use the full fancy-regex as both core scan
    // and verifier.
    return Ok(StrippedPattern {
      core: core,
      verifier: Some(verifier),
      original_index: idx,
    });
  }

  Ok(StrippedPattern {
    core,
    verifier: Some(verifier),
    original_index: idx,
  })
}

/// Strip lookaround assertions from a pattern
/// string. Handles:
/// - Leading (?<=...) and (?<!...)
/// - Trailing (?=...) and (?!...)
fn strip_lookaround_str(pattern: &str) -> String {
  let mut result = pattern.to_string();

  // Strip leading lookbehind: (?<=...) or (?<!...)
  while result.starts_with("(?<=")
    || result.starts_with("(?<!")
  {
    if let Some(end) =
      find_matching_paren(&result, 0)
    {
      result = result[end + 1..].to_string();
    } else {
      break;
    }
  }

  // Strip trailing lookahead: (?=...) or (?!...)
  // Find from the end
  loop {
    let trimmed = result.trim_end();
    if trimmed.ends_with(')') {
      // Find the opening of the last group
      if let Some(start) =
        find_last_lookahead_start(trimmed)
      {
        result =
          trimmed[..start].to_string();
      } else {
        break;
      }
    } else {
      break;
    }
  }

  result
}

/// Find the matching closing paren for an opening
/// paren at position `start`.
fn find_matching_paren(
  s: &str,
  start: usize,
) -> Option<usize> {
  let bytes = s.as_bytes();
  let mut depth = 0;
  let mut i = start;
  let mut escaped = false;

  while i < bytes.len() {
    if escaped {
      escaped = false;
      i += 1;
      continue;
    }
    match bytes[i] {
      b'\\' => escaped = true,
      b'(' => depth += 1,
      b')' => {
        depth -= 1;
        if depth == 0 {
          return Some(i);
        }
      }
      _ => {}
    }
    i += 1;
  }
  None
}

/// Find the start of a trailing lookahead group.
fn find_last_lookahead_start(
  s: &str,
) -> Option<usize> {
  // Walk backwards from the last ')' to find
  // the matching '(' that starts (?= or (?!
  let bytes = s.as_bytes();
  if bytes.is_empty() || *bytes.last()? != b')' {
    return None;
  }

  let mut depth = 0;
  let mut i = bytes.len() - 1;

  loop {
    match bytes[i] {
      b')' => depth += 1,
      b'(' => {
        depth -= 1;
        if depth == 0 {
          // Check if this is (?= or (?!
          if i + 2 < bytes.len()
            && bytes[i + 1] == b'?'
            && (bytes[i + 2] == b'='
              || bytes[i + 2] == b'!')
          {
            return Some(i);
          }
          return None;
        }
      }
      _ => {}
    }
    if i == 0 {
      break;
    }
    i -= 1;
  }
  None
}

// ─── Engine ───────────────────────────────────

struct PatternInfo {
  /// Index in the original patterns array.
  original_index: u32,
  /// If Some, this match needs verification with
  /// fancy-regex (because lookaround was stripped).
  verifier: Option<fancy_regex::Regex>,
}

/// Patterns that couldn't be added to the multi-DFA
/// even after stripping (complex lookaround or
/// unsupported features). These run as individual
/// fancy-regex passes.
struct FallbackPattern {
  original_index: u32,
  regex: fancy_regex::Regex,
}

#[napi]
pub struct RegexSet {
  /// Multi-pattern DFA (fast, single pass).
  /// Contains all patterns (some with lookaround
  /// stripped to their core).
  multi: Option<MetaRegex>,
  /// Metadata per multi-DFA pattern slot.
  info: Vec<PatternInfo>,
  /// Patterns that couldn't join the multi-DFA.
  fallbacks: Vec<FallbackPattern>,
  pattern_count: u32,
}

#[napi]
impl RegexSet {
  #[napi(constructor)]
  pub fn new(
    patterns: Vec<String>,
    options: Option<Options>,
  ) -> Result<Self> {
    let whole_words = options
      .and_then(|o| o.whole_words)
      .unwrap_or(false);

    let pattern_count = patterns.len() as u32;

    let wrapped: Vec<String> = if whole_words {
      patterns
        .iter()
        .map(|p| format!("\\b(?:{p})\\b"))
        .collect()
    } else {
      patterns
    };

    // Process each pattern: strip lookaround,
    // try to add core to multi-DFA.
    let mut cores: Vec<String> = Vec::new();
    let mut info: Vec<PatternInfo> = Vec::new();
    let mut fallbacks: Vec<FallbackPattern> =
      Vec::new();

    for (i, p) in wrapped.iter().enumerate() {
      let stripped = strip_lookaround(p, i)
        .map_err(Error::from_reason)?;

      // Try to add the core to the multi-DFA.
      if MetaRegex::new(&stripped.core).is_ok() {
        let slot = cores.len();
        cores.push(stripped.core);
        info.push(PatternInfo {
          original_index: stripped.original_index
            as u32,
          verifier: stripped.verifier,
        });
      } else if let Some(v) = stripped.verifier {
        // Core doesn't compile; use full
        // fancy-regex as fallback.
        fallbacks.push(FallbackPattern {
          original_index: i as u32,
          regex: v,
        });
      } else {
        return Err(Error::from_reason(format!(
          "Failed to compile pattern {i}: no valid engine"
        )));
      }
    }

    // Build the multi-DFA from all cores.
    let multi = if cores.is_empty() {
      None
    } else {
      let refs: Vec<&str> =
        cores.iter().map(|s| s.as_str()).collect();
      Some(MetaRegex::new_many(&refs).map_err(
        |e| {
          Error::from_reason(format!(
            "Failed to compile regex: {e}"
          ))
        },
      )?)
    };

    Ok(Self {
      multi,
      info,
      fallbacks,
      pattern_count,
    })
  }

  #[napi(getter)]
  pub fn pattern_count(&self) -> u32 {
    self.pattern_count
  }

  #[napi]
  pub fn is_match(&self, haystack: String) -> bool {
    // Check multi-DFA matches (with verification).
    if let Some(ref multi) = self.multi {
      for m in multi.find_iter(&haystack) {
        let slot = m.pattern().as_usize();
        let pi = &self.info[slot];
        if let Some(ref v) = pi.verifier {
          // Verify on small window around match.
          let ctx_start = m.start().saturating_sub(10);
          let ctx_end =
            (m.end() + 10).min(haystack.len());
          // Ensure we're at char boundaries.
          let ctx_start = haystack
            .floor_char_boundary(ctx_start);
          let ctx_end =
            haystack.ceil_char_boundary(ctx_end);
          let window = &haystack[ctx_start..ctx_end];
          let offset = m.start() - ctx_start;
          if v
            .find_from_pos(window, offset)
            .ok()
            .flatten()
            .is_some()
          {
            return true;
          }
        } else {
          return true;
        }
      }
    }

    // Check fallback patterns.
    for fb in &self.fallbacks {
      if fb
        .regex
        .is_match(&haystack)
        .unwrap_or(false)
      {
        return true;
      }
    }

    false
  }

  #[napi(js_name = "_findIterPacked")]
  pub fn find_iter_packed(
    &self,
    haystack: String,
  ) -> Uint32Array {
    let mut all: Vec<(u32, usize, usize)> =
      Vec::new();

    // Multi-DFA pass (fast, single scan).
    if let Some(ref multi) = self.multi {
      for m in multi.find_iter(&haystack) {
        let slot = m.pattern().as_usize();
        let pi = &self.info[slot];

        if let Some(ref v) = pi.verifier {
          // Verify with fancy-regex on a window.
          let ctx_start =
            m.start().saturating_sub(20);
          let ctx_end =
            (m.end() + 20).min(haystack.len());
          let ctx_start = floor_char_boundary(
            &haystack, ctx_start,
          );
          let ctx_end = ceil_char_boundary(
            &haystack, ctx_end,
          );
          let window =
            &haystack[ctx_start..ctx_end];
          let offset = m.start() - ctx_start;

          if let Ok(Some(vm)) =
            v.find_from_pos(window, offset)
          {
            // Use the verified match's span
            // (may differ from core's span).
            all.push((
              pi.original_index,
              ctx_start + vm.start(),
              ctx_start + vm.end(),
            ));
          }
        } else {
          all.push((
            pi.original_index,
            m.start(),
            m.end(),
          ));
        }
      }
    }

    // Fallback passes (individual fancy-regex).
    for fb in &self.fallbacks {
      let mut pos = 0;
      while pos <= haystack.len() {
        match fb
          .regex
          .find_from_pos(&haystack, pos)
        {
          Ok(Some(m)) => {
            all.push((
              fb.original_index,
              m.start(),
              m.end(),
            ));
            pos = m.end().max(pos + 1);
          }
          _ => break,
        }
      }
    }

    if all.is_empty() {
      return Uint32Array::new(Vec::new());
    }

    // Sort by start, longest first at ties.
    all.sort_by(|a, b| {
      a.1
        .cmp(&b.1)
        .then_with(|| (b.2 - b.1).cmp(&(a.2 - a.1)))
    });

    // Greedily select non-overlapping.
    let mut selected: Vec<(u32, usize, usize)> =
      Vec::new();
    let mut last_end: usize = 0;
    for &(pat, start, end) in &all {
      if start >= last_end {
        selected.push((pat, start, end));
        last_end = end;
      }
    }

    // Convert to UTF-16 offsets.
    if haystack.is_ascii() {
      let mut packed = Vec::with_capacity(
        selected.len() * 3,
      );
      for (pat, start, end) in selected {
        packed.push(pat);
        packed.push(start as u32);
        packed.push(end as u32);
      }
      return Uint32Array::new(packed);
    }

    let bytes = haystack.as_bytes();
    let mut packed = Vec::with_capacity(
      selected.len() * 3,
    );
    let mut last_byte: usize = 0;
    let mut last_utf16: u32 = 0;

    for (pat, start, end) in selected {
      last_utf16 += byte_span_utf16_len(
        &bytes[last_byte..start],
      );
      let utf16_start = last_utf16;
      last_byte = start;

      last_utf16 += byte_span_utf16_len(
        &bytes[last_byte..end],
      );
      let utf16_end = last_utf16;
      last_byte = end;

      packed.push(pat);
      packed.push(utf16_start);
      packed.push(utf16_end);
    }
    Uint32Array::new(packed)
  }

  #[napi]
  pub fn which_match(
    &self,
    haystack: String,
  ) -> Vec<u32> {
    let mut seen = vec![
      false;
      self.pattern_count as usize
    ];
    let mut result = Vec::new();

    // Use findIter logic to get verified matches.
    let packed = self.find_iter_packed(
      haystack.clone(),
    );
    let data: &[u32] = packed.as_ref();
    let mut i = 0;
    while i < data.len() {
      let idx = data[i] as usize;
      if !seen[idx] {
        seen[idx] = true;
        result.push(idx as u32);
      }
      i += 3;
    }
    result
  }

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

    // Get all verified matches (byte offsets).
    let mut all: Vec<(u32, usize, usize)> =
      Vec::new();

    if let Some(ref multi) = self.multi {
      for m in multi.find_iter(&haystack) {
        let slot = m.pattern().as_usize();
        let pi = &self.info[slot];

        if let Some(ref v) = pi.verifier {
          let ctx_start =
            m.start().saturating_sub(20);
          let ctx_end =
            (m.end() + 20).min(haystack.len());
          let ctx_start = floor_char_boundary(
            &haystack, ctx_start,
          );
          let ctx_end = ceil_char_boundary(
            &haystack, ctx_end,
          );
          let window =
            &haystack[ctx_start..ctx_end];
          let offset = m.start() - ctx_start;

          if let Ok(Some(vm)) =
            v.find_from_pos(window, offset)
          {
            all.push((
              pi.original_index,
              ctx_start + vm.start(),
              ctx_start + vm.end(),
            ));
          }
        } else {
          all.push((
            pi.original_index,
            m.start(),
            m.end(),
          ));
        }
      }
    }

    for fb in &self.fallbacks {
      let mut pos = 0;
      while pos <= haystack.len() {
        match fb
          .regex
          .find_from_pos(&haystack, pos)
        {
          Ok(Some(m)) => {
            all.push((
              fb.original_index,
              m.start(),
              m.end(),
            ));
            pos = m.end().max(pos + 1);
          }
          _ => break,
        }
      }
    }

    all.sort_by(|a, b| {
      a.1
        .cmp(&b.1)
        .then_with(|| (b.2 - b.1).cmp(&(a.2 - a.1)))
    });

    let mut result = String::with_capacity(
      haystack.len(),
    );
    let mut last: usize = 0;
    let mut last_end: usize = 0;

    for (pat, start, end) in all {
      if start >= last_end {
        result.push_str(&haystack[last..start]);
        result.push_str(
          &replacements[pat as usize],
        );
        last = end;
        last_end = end;
      }
    }
    result.push_str(&haystack[last..]);
    Ok(result)
  }
}

// ─── Char boundary helpers ────────────────────

fn floor_char_boundary(
  s: &str,
  mut i: usize,
) -> usize {
  while i > 0 && !s.is_char_boundary(i) {
    i -= 1;
  }
  i
}

fn ceil_char_boundary(
  s: &str,
  mut i: usize,
) -> usize {
  while i < s.len() && !s.is_char_boundary(i) {
    i += 1;
  }
  i
}
