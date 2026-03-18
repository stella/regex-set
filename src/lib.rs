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

// ─── Inline boundary checks ──────────────────
//
// Instead of calling fancy-regex on a window for
// every match, classify the lookaround assertion
// and inline it as a direct char check (~1ns vs
// ~1μs per match).

/// A fast inline check that replaces fancy-regex
/// verification for simple lookaround assertions.
enum Verifier {
  /// No verification needed.
  None,
  /// Inline char check (covers 90%+ of real
  /// lookaround patterns).
  Inline(InlineCheck),
  /// Complex lookaround: use fancy-regex on a
  /// small window.
  Complex(fancy_regex::Regex),
}

/// Inline boundary check for a single char.
struct InlineCheck {
  /// Check before match start.
  pre: Option<CharCheck>,
  /// Check after match end.
  post: Option<CharCheck>,
}

/// A single character assertion.
/// Fast character classifier — avoids regex
/// dispatch overhead by using native Rust functions.
enum CharClass {
  /// `\d` or `[0-9]`
  Digit,
  /// `\w` or `[a-zA-Z0-9_]`
  WordChar,
  /// `\s` or `[\t\n\r ]`
  Whitespace,
  /// `\p{L}` or `\p{Alphabetic}`
  Alpha,
  /// `\p{N}` or `\p{Numeric}`
  Numeric,
  /// Fallback: compiled regex for unknown classes
  Regex(regex::Regex),
}

impl CharClass {
  fn matches_char(&self, ch: char) -> bool {
    match self {
      // Unicode-aware to match Rust regex semantics
      CharClass::Digit => ch.is_numeric(),
      CharClass::WordChar => {
        ch.is_alphanumeric()
          || ch == '_'
          || ch == '\u{200C}' // ZWJ
          || ch == '\u{200D}' // ZWNJ
      }
      CharClass::Whitespace => ch.is_whitespace(),
      CharClass::Alpha => ch.is_alphabetic(),
      CharClass::Numeric => ch.is_numeric(),
      CharClass::Regex(re) => {
        let mut buf = [0u8; 4];
        re.is_match(ch.encode_utf8(&mut buf))
      }
    }
  }

  /// Parse a char class from the assertion content.
  fn from_str(
    s: &str,
  ) -> std::result::Result<Self, String> {
    match s {
      "\\d" | "[0-9]" => Ok(CharClass::Digit),
      "\\w" | "[a-zA-Z0-9_]" => {
        Ok(CharClass::WordChar)
      }
      "\\s" | "[\\t\\n\\r ]" => {
        Ok(CharClass::Whitespace)
      }
      "\\p{L}" | "\\p{Alphabetic}"
      | "\\p{Letter}" => Ok(CharClass::Alpha),
      "\\p{N}" | "\\p{Numeric}"
      | "\\p{Number}" => Ok(CharClass::Numeric),
      _ => {
        let re = regex::Regex::new(s)
          .map_err(|e| format!("{e}"))?;
        Ok(CharClass::Regex(re))
      }
    }
  }
}

struct CharCheck {
  class: CharClass,
  negated: bool,
}

impl CharCheck {
  fn test(
    &self,
    haystack: &str,
    pos: usize,
  ) -> bool {
    if pos >= haystack.len() {
      return self.negated;
    }
    let ch = haystack[pos..].chars().next().unwrap();
    let matches = self.class.matches_char(ch);
    if self.negated {
      !matches
    } else {
      matches
    }
  }

  fn test_before(
    &self,
    haystack: &str,
    pos: usize,
  ) -> bool {
    if pos == 0 {
      return self.negated;
    }
    let ch =
      haystack[..pos].chars().next_back().unwrap();
    let matches = self.class.matches_char(ch);
    if self.negated {
      !matches
    } else {
      matches
    }
  }
}

fn char_len_at(s: &str, pos: usize) -> usize {
  let b = s.as_bytes()[pos];
  if b < 0x80 {
    1
  } else if b < 0xE0 {
    2
  } else if b < 0xF0 {
    3
  } else {
    4
  }
}

fn prev_char_start(s: &str, pos: usize) -> usize {
  let mut i = pos - 1;
  while i > 0 && !s.is_char_boundary(i) {
    i -= 1;
  }
  i
}

// ─── Lookaround parsing ──────────────────────

fn has_lookaround(pattern: &str) -> bool {
  pattern.contains("(?=")
    || pattern.contains("(?!")
    || pattern.contains("(?<=")
    || pattern.contains("(?<!")
}

/// Extract leading lookbehind assertion content.
/// Returns (content, is_negated, rest_of_pattern).
fn extract_leading_lookbehind(
  pattern: &str,
) -> Option<(String, bool, String)> {
  let (prefix, negated) =
    if pattern.starts_with("(?<!") {
      ("(?<!", true)
    } else if pattern.starts_with("(?<=") {
      ("(?<=", false)
    } else {
      return None;
    };

  let end = find_matching_paren(pattern, 0)?;
  let content =
    pattern[prefix.len()..end].to_string();
  let rest = pattern[end + 1..].to_string();
  Some((content, negated, rest))
}

/// Extract trailing lookahead assertion content.
/// Returns (rest_of_pattern, content, is_negated).
fn extract_trailing_lookahead(
  pattern: &str,
) -> Option<(String, String, bool)> {
  let start = find_last_lookahead_start(pattern)?;
  let end = pattern.len() - 1; // last ')'

  let prefix_len = if &pattern[start..start + 3]
    == "(?!"
  {
    3
  } else if &pattern[start..start + 3] == "(?=" {
    3
  } else {
    return None;
  };

  let negated = &pattern[start + 2..start + 3] == "!";
  let content =
    pattern[start + prefix_len..end].to_string();
  let rest = pattern[..start].to_string();
  Some((rest, content, negated))
}

/// Check if a char-class content string is
/// "simple" (matches a single character). Simple
/// means: no quantifiers, no alternation, no
/// groups.
fn is_simple_char_class(content: &str) -> bool {
  !content.contains('*')
    && !content.contains('+')
    && !content.contains('?')
    && !content.contains('{')
    && !content.contains('|')
    && !content.contains('(')
    && CharClass::from_str(content).is_ok()
}

/// Build a Verifier from a pattern's lookaround.
fn build_verifier(
  pattern: &str,
) -> std::result::Result<(String, Verifier), String>
{
  if !has_lookaround(pattern) {
    return Ok((
      pattern.to_string(),
      Verifier::None,
    ));
  }

  let mut core = pattern.to_string();
  let mut pre: Option<CharCheck> = None;
  let mut post: Option<CharCheck> = None;

  // Extract leading lookbehind.
  if let Some((content, negated, rest)) =
    extract_leading_lookbehind(&core)
  {
    if is_simple_char_class(&content) {
      let class = CharClass::from_str(&content)
        .map_err(|e| format!("{e}"))?;
      pre = Some(CharCheck {
        class,
        negated,
      });
      core = rest;
    }
  }

  // Extract trailing lookahead.
  if let Some((rest, content, negated)) =
    extract_trailing_lookahead(&core)
  {
    if is_simple_char_class(&content) {
      let class = CharClass::from_str(&content)
        .map_err(|e| format!("{e}"))?;
      post = Some(CharCheck {
        class,
        negated,
      });
      core = rest;
    }
  }

  // Check if all lookaround was inlined.
  if !has_lookaround(&core) && (pre.is_some() || post.is_some()) {
    return Ok((
      core,
      Verifier::Inline(InlineCheck { pre, post }),
    ));
  }

  // Still has lookaround (complex or nested).
  // Fall back to fancy-regex, which does not
  // support (?-u:\b). Revert to Unicode \b.
  let core_stripped =
    strip_lookaround_str(pattern);
  let fancy_pat = revert_ascii_boundaries(pattern);
  let verifier =
    fancy_regex::Regex::new(&fancy_pat)
      .map_err(|e| format!("{e}"))?;

  Ok((core_stripped, Verifier::Complex(verifier)))
}

impl Verifier {
  fn check(
    &self,
    haystack: &str,
    start: usize,
    end: usize,
  ) -> bool {
    match self {
      Verifier::None => true,
      Verifier::Inline(ic) => {
        if let Some(ref pre) = ic.pre {
          if !pre.test_before(haystack, start) {
            return false;
          }
        }
        if let Some(ref post) = ic.post {
          if !post.test(haystack, end) {
            return false;
          }
        }
        true
      }
      Verifier::Complex(re) => {
        let ctx_start =
          start.saturating_sub(20);
        let ctx_end =
          (end + 20).min(haystack.len());
        let ctx_start =
          floor_char_boundary(haystack, ctx_start);
        let ctx_end =
          ceil_char_boundary(haystack, ctx_end);
        let window =
          &haystack[ctx_start..ctx_end];
        let offset = start - ctx_start;
        re.find_from_pos(window, offset)
          .ok()
          .flatten()
          .is_some()
      }
    }
  }
}

// ─── String helpers ───────────────────────────

fn strip_lookaround_str(pattern: &str) -> String {
  let mut result = pattern.to_string();
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
  loop {
    let trimmed = result.trim_end();
    if trimmed.ends_with(')') {
      if let Some(start) =
        find_last_lookahead_start(trimmed)
      {
        result = trimmed[..start].to_string();
      } else {
        break;
      }
    } else {
      break;
    }
  }
  result
}

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

fn find_last_lookahead_start(
  s: &str,
) -> Option<usize> {
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

/// Revert `(?-u:\b)` / `(?-u:\B)` back to `\b` /
/// `\B` for fancy-regex, which does not support
/// the `(?-u:...)` Unicode-disable syntax.
fn revert_ascii_boundaries(s: &str) -> String {
  s.replace("(?-u:\\b)", "\\b")
    .replace("(?-u:\\B)", "\\B")
}

// ─── Engine ───────────────────────────────────

struct PatternInfo {
  original_index: u32,
  verifier: Verifier,
}

struct FallbackPattern {
  original_index: u32,
  regex: fancy_regex::Regex,
}

#[napi]
pub struct RegexSet {
  multi: Option<MetaRegex>,
  info: Vec<PatternInfo>,
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
        .map(|p| format!("(?-u:\\b)(?:{p})(?-u:\\b)"))
        .collect()
    } else {
      patterns
    };

    let mut cores: Vec<String> = Vec::new();
    let mut info: Vec<PatternInfo> = Vec::new();
    let mut fallbacks: Vec<FallbackPattern> =
      Vec::new();

    for (i, p) in wrapped.iter().enumerate() {
      let (core, verifier) = build_verifier(p)
        .map_err(|e| {
          Error::from_reason(format!(
            "Failed to compile pattern {i}: {e}"
          ))
        })?;

      if MetaRegex::new(&core).is_ok() {
        cores.push(core);
        info.push(PatternInfo {
          original_index: i as u32,
          verifier,
        });
      } else {
        // Core doesn't compile; full fallback.
        // fancy-regex doesn't support (?-u:\b).
        let fancy_pat =
          revert_ascii_boundaries(p);
        let re =
          fancy_regex::Regex::new(&fancy_pat)
            .map_err(|e| {
              Error::from_reason(format!(
                "Failed to compile pattern {i}: {e}"
              ))
            })?;
        fallbacks.push(FallbackPattern {
          original_index: i as u32,
          regex: re,
        });
      }
    }

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
    if let Some(ref multi) = self.multi {
      for m in multi.find_iter(&haystack) {
        let pi = &self.info[m.pattern().as_usize()];
        if pi.verifier.check(
          &haystack,
          m.start(),
          m.end(),
        ) {
          return true;
        }
      }
    }
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

    if let Some(ref multi) = self.multi {
      for m in multi.find_iter(&haystack) {
        let pi = &self.info[m.pattern().as_usize()];
        if pi.verifier.check(
          &haystack,
          m.start(),
          m.end(),
        ) {
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
        match fb.regex.find_from_pos(&haystack, pos)
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

    // Pack with UTF-16 offsets.
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

    if let Some(ref multi) = self.multi {
      for m in multi.find_iter(&haystack) {
        let pi = &self.info[m.pattern().as_usize()];
        if pi.verifier.check(
          &haystack,
          m.start(),
          m.end(),
        ) {
          let idx = pi.original_index as usize;
          if !seen[idx] {
            seen[idx] = true;
            result.push(idx as u32);
          }
        }
      }
    }

    for fb in &self.fallbacks {
      let idx = fb.original_index as usize;
      if !seen[idx]
        && fb
          .regex
          .is_match(&haystack)
          .unwrap_or(false)
      {
        seen[idx] = true;
        result.push(idx as u32);
      }
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

    // Collect all verified matches.
    let mut all: Vec<(usize, usize, usize)> =
      Vec::new();

    if let Some(ref multi) = self.multi {
      for m in multi.find_iter(&haystack) {
        let pi = &self.info[m.pattern().as_usize()];
        if pi.verifier.check(
          &haystack,
          m.start(),
          m.end(),
        ) {
          all.push((
            pi.original_index as usize,
            m.start(),
            m.end(),
          ));
        }
      }
    }

    for fb in &self.fallbacks {
      let mut pos = 0;
      while pos <= haystack.len() {
        match fb.regex.find_from_pos(&haystack, pos)
        {
          Ok(Some(m)) => {
            all.push((
              fb.original_index as usize,
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
        result.push_str(&replacements[pat]);
        last = end;
        last_end = end;
      }
    }
    result.push_str(&haystack[last..]);
    Ok(result)
  }
}
