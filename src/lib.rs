use napi::bindgen_prelude::*;
use napi_derive::napi;
use regex_automata::meta::Regex as MetaRegex;
use regex_automata::Input;
use unicode_segmentation::UnicodeSegmentation;

/// Options for constructing a `RegexSet`.
#[napi(object)]
pub struct Options {
  /// Only match whole words. Default: `false`.
  pub whole_words: Option<bool>,
  /// Use Unicode word boundaries. Default: `false`.
  ///
  /// When `true`, `\b` matches at Unicode word
  /// boundaries (accented letters, CJK, etc. are
  /// word chars). When `false`, `\b` uses ASCII
  /// semantics matching JS `RegExp` behavior.
  ///
  /// Implementation: edge `\b` is stripped from the
  /// pattern and verified inline per match (O(1)),
  /// so there is zero DFA overhead regardless of
  /// which mode is used.
  pub unicode_boundaries: Option<bool>,
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

// ─── Word boundary verification ─────────────

fn is_word_char_unicode(ch: char) -> bool {
  ch.is_alphanumeric() || ch == '_'
}

fn is_word_char_ascii(ch: char) -> bool {
  ch.is_ascii_alphanumeric() || ch == '_'
}

/// Check word boundary at a byte position.
fn check_word_boundary(
  haystack: &str,
  byte_pos: usize,
  unicode: bool,
) -> bool {
  let is_wc = if unicode {
    is_word_char_unicode
  } else {
    is_word_char_ascii
  };

  let before = if byte_pos == 0 {
    false
  } else {
    let ch = haystack[..byte_pos]
      .chars()
      .next_back()
      .unwrap();
    is_wc(ch)
  };
  let after = if byte_pos >= haystack.len() {
    false
  } else {
    let ch =
      haystack[byte_pos..].chars().next().unwrap();
    is_wc(ch)
  };
  before != after
}

// ─── UAX#29 segmenter fallback ──────────────
//
// For scripts where is_alphanumeric() diverges
// from UAX#29 word boundaries (Thai, CJK, Lao,
// Khmer, Myanmar), pre-compute the boundary set
// using the unicode-segmentation crate. Only
// activated when the haystack actually contains
// these scripts.

/// Fast byte scan: does the haystack contain any
/// script that needs UAX#29 segmentation?
fn needs_segmenter(haystack: &str) -> bool {
  // SIMD-optimized: pure ASCII never needs it.
  if haystack.is_ascii() {
    return false;
  }
  let bytes = haystack.as_bytes();
  let mut i = 0;
  while i < bytes.len() {
    let b = bytes[i];
    if b < 0x80 {
      i += 1;
      continue;
    }
    if b < 0xE0 {
      i += 2;
      continue;
    }
    // 3-byte UTF-8: decode the code point
    if b < 0xF0 && i + 2 < bytes.len() {
      let cp = ((b as u32 & 0x0F) << 12)
        | ((bytes[i + 1] as u32 & 0x3F) << 6)
        | (bytes[i + 2] as u32 & 0x3F);
      // Thai: U+0E00–U+0E7F
      // Lao: U+0E80–U+0EFF
      // Myanmar: U+1000–U+109F
      // Khmer: U+1780–U+17FF
      // CJK Unified: U+4E00–U+9FFF
      // CJK Ext A: U+3400–U+4DBF
      // Hiragana: U+3040–U+309F
      // Katakana: U+30A0–U+30FF
      // Hangul: U+AC00–U+D7AF
      if (0x0E00..=0x0E7F).contains(&cp)  // Thai
        || (0x0E80..=0x0EFF).contains(&cp) // Lao
        || (0x1000..=0x109F).contains(&cp) // Myanmar
        || (0x1780..=0x17FF).contains(&cp) // Khmer
        || (0x3040..=0x30FF).contains(&cp) // Kana
        || (0x3400..=0x9FFF).contains(&cp) // CJK
        || (0xAC00..=0xD7AF).contains(&cp) // Hangul
      {
        return true;
      }
      i += 3;
      continue;
    }
    // 4-byte: CJK Ext B+ (U+20000+)
    if b >= 0xF0 && i + 3 < bytes.len() {
      let cp = ((b as u32 & 0x07) << 18)
        | ((bytes[i + 1] as u32 & 0x3F) << 12)
        | ((bytes[i + 2] as u32 & 0x3F) << 6)
        | (bytes[i + 3] as u32 & 0x3F);
      if (0x20000..=0x2FA1F).contains(&cp) {
        return true;
      }
      i += 4;
      continue;
    }
    i += 1;
  }
  false
}

/// Bit set for O(1) word boundary lookups.
/// For a 34KB document: 547 u64 values = 4.3KB.
struct BoundaryBitSet {
  bits: Vec<u64>,
}

impl BoundaryBitSet {
  fn new(len: usize) -> Self {
    Self {
      bits: vec![0u64; (len + 63) / 64],
    }
  }

  fn set(&mut self, pos: usize) {
    if pos < self.bits.len() * 64 {
      self.bits[pos / 64] |= 1u64 << (pos % 64);
    }
  }

  fn contains(&self, pos: usize) -> bool {
    pos < self.bits.len() * 64
      && self.bits[pos / 64]
        & (1u64 << (pos % 64))
        != 0
  }
}

/// Compute UAX#29 word boundaries as a bit set.
/// No sort needed: unicode_word_indices returns
/// positions in order. O(1) lookup per position.
fn compute_uax29_boundaries(
  haystack: &str,
) -> BoundaryBitSet {
  use unicode_segmentation::UnicodeSegmentation;
  let mut bs = BoundaryBitSet::new(
    haystack.len() + 1,
  );
  bs.set(0);
  bs.set(haystack.len());
  for (offset, word) in
    haystack.unicode_word_indices()
  {
    bs.set(offset);
    bs.set(offset + word.len());
  }
  bs
}

/// Boundary checker: inline is_alphanumeric or
/// pre-computed UAX#29 bit set.
enum BoundaryMode {
  Inline { unicode: bool },
  Segmenter { bitset: BoundaryBitSet },
}

impl BoundaryMode {
  fn is_boundary(&self, pos: usize) -> bool {
    match self {
      BoundaryMode::Segmenter { bitset } => {
        bitset.contains(pos)
      }
      BoundaryMode::Inline { .. } => {
        unreachable!()
      }
    }
  }
}

/// Strip leading/trailing `\b` or `\B` from a
/// pattern string.
fn strip_edge_boundaries(
  pattern: &str,
) -> (String, EdgeBoundaries) {
  let bytes = pattern.as_bytes();
  let mut start = 0;
  let mut end = bytes.len();
  let mut eb = EdgeBoundaries::default();

  // Leading \b or \B
  if end - start >= 2
    && bytes[start] == b'\\'
    && (bytes[start + 1] == b'b'
      || bytes[start + 1] == b'B')
  {
    if bytes[start + 1] == b'b' {
      eb.leading_b = true;
    } else {
      eb.leading_big_b = true;
    }
    start += 2;
  }

  // Trailing \b or \B. Count consecutive
  // backslashes: odd = boundary, even = escaped.
  if end - start >= 2
    && (bytes[end - 1] == b'b'
      || bytes[end - 1] == b'B')
    && bytes[end - 2] == b'\\'
  {
    let mut num_bs = 0usize;
    let mut k = end - 2;
    while k > start && bytes[k - 1] == b'\\' {
      num_bs += 1;
      k -= 1;
    }
    if num_bs % 2 == 0 {
      if bytes[end - 1] == b'b' {
        eb.trailing_b = true;
      } else {
        eb.trailing_big_b = true;
      }
      end -= 2;
    }
  }

  (pattern[start..end].to_string(), eb)
}

#[derive(Default, Clone, Copy)]
struct EdgeBoundaries {
  leading_b: bool,
  trailing_b: bool,
  leading_big_b: bool,
  trailing_big_b: bool,
}

impl EdgeBoundaries {
  fn has_any(&self) -> bool {
    self.leading_b
      || self.trailing_b
      || self.leading_big_b
      || self.trailing_big_b
  }

  fn check(
    &self,
    haystack: &str,
    start: usize,
    end: usize,
    unicode: bool,
  ) -> bool {
    self.check_with_mode(
      haystack,
      start,
      end,
      &BoundaryMode::Inline { unicode },
    )
  }

  fn check_with_mode(
    &self,
    haystack: &str,
    start: usize,
    end: usize,
    mode: &BoundaryMode,
  ) -> bool {
    let is_wb = |pos: usize| -> bool {
      match mode {
        BoundaryMode::Inline { unicode } => {
          check_word_boundary(
            haystack, pos, *unicode,
          )
        }
        BoundaryMode::Segmenter { .. } => {
          mode.is_boundary(pos)
        }
      }
    };

    if self.leading_b && !is_wb(start) {
      return false;
    }
    if self.trailing_b && !is_wb(end) {
      return false;
    }
    if self.leading_big_b && is_wb(start) {
      return false;
    }
    if self.trailing_big_b && is_wb(end) {
      return false;
    }
    true
  }
}

// ─── Inline lookaround checks ────────────────

enum Verifier {
  None,
  Inline(InlineCheck),
  Complex(fancy_regex::Regex),
}

struct InlineCheck {
  pre: Option<CharCheck>,
  post: Option<CharCheck>,
}

enum CharClass {
  Digit,
  WordChar,
  Whitespace,
  Alpha,
  Numeric,
  Regex(regex::Regex),
}

impl CharClass {
  fn matches_char(&self, ch: char) -> bool {
    match self {
      CharClass::Digit => ch.is_numeric(),
      CharClass::WordChar => {
        ch.is_alphanumeric()
          || ch == '_'
          || ch == '\u{200C}'
          || ch == '\u{200D}'
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
    if self.negated { !matches } else { matches }
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
    if self.negated { !matches } else { matches }
  }
}

// ─── Lookaround parsing ──────────────────────

fn has_lookaround(pattern: &str) -> bool {
  pattern.contains("(?=")
    || pattern.contains("(?!")
    || pattern.contains("(?<=")
    || pattern.contains("(?<!")
}

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

fn extract_trailing_lookahead(
  pattern: &str,
) -> Option<(String, String, bool)> {
  let start = find_last_lookahead_start(pattern)?;
  let end = pattern.len() - 1;
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

fn is_simple_char_class(content: &str) -> bool {
  !content.contains('*')
    && !content.contains('+')
    && !content.contains('?')
    && !content.contains('{')
    && !content.contains('|')
    && !content.contains('(')
    && CharClass::from_str(content).is_ok()
}

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

  if let Some((content, negated, rest)) =
    extract_leading_lookbehind(&core)
  {
    if is_simple_char_class(&content) {
      let class = CharClass::from_str(&content)
        .map_err(|e| format!("{e}"))?;
      pre = Some(CharCheck { class, negated });
      core = rest;
    }
  }

  if let Some((rest, content, negated)) =
    extract_trailing_lookahead(&core)
  {
    if is_simple_char_class(&content) {
      let class = CharClass::from_str(&content)
        .map_err(|e| format!("{e}"))?;
      post = Some(CharCheck { class, negated });
      core = rest;
    }
  }

  if !has_lookaround(&core)
    && (pre.is_some() || post.is_some())
  {
    return Ok((
      core,
      Verifier::Inline(InlineCheck { pre, post }),
    ));
  }

  // Complex lookaround → fancy-regex fallback.
  // ascii_boundary_for_fancy() expresses ASCII \b
  // as lookaround on [a-zA-Z0-9_].
  let core_stripped =
    strip_lookaround_str(pattern);
  let fancy_pat = ascii_boundary_for_fancy(pattern);
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
        // Must match exactly at offset.
        re.find_from_pos(window, offset)
          .ok()
          .flatten()
          .filter(|m| m.start() == offset)
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

const W: &str = "[a-zA-Z0-9_]";

fn ascii_boundary_for_fancy(s: &str) -> String {
  let b = format!(
    "(?:(?<={W})(?!{W})|(?<!{W})(?={W}))",
  );
  let big_b = format!(
    "(?:(?<={W})(?={W})|(?<!{W})(?!{W}))",
  );
  s.replace("(?-u:\\b)", &b)
    .replace("(?-u:\\B)", &big_b)
}

// ─── Match checking ─────────────────────────

enum Rejection {
  Boundary,
  Verifier,
}

fn check_match(
  haystack: &str,
  start: usize,
  end: usize,
  verifier: &Verifier,
  boundaries: &EdgeBoundaries,
  mode: &BoundaryMode,
) -> std::result::Result<(), Rejection> {
  if boundaries.has_any()
    && !boundaries.check_with_mode(
      haystack, start, end, mode,
    )
  {
    return Err(Rejection::Boundary);
  }
  if !verifier.check(haystack, start, end) {
    return Err(Rejection::Verifier);
  }
  Ok(())
}

// ─── Engine ───────────────────────────────────

struct PatternInfo {
  original_index: u32,
  verifier: Verifier,
  boundaries: EdgeBoundaries,
  unicode_wb: bool,
  individual: MetaRegex,
}

struct FallbackPattern {
  original_index: u32,
  regex: fancy_regex::Regex,
  boundaries: EdgeBoundaries,
  unicode_wb: bool,
}

/// A verified match: (original_pattern_index,
/// byte_start, byte_end).
type RawMatch = (u32, usize, usize);

#[napi]
pub struct RegexSet {
  multi: Option<MetaRegex>,
  info: Vec<PatternInfo>,
  fallbacks: Vec<FallbackPattern>,
  pattern_count: u32,
  has_boundaryless_pattern: bool,
  /// True if patterns have different boundary
  /// configs (e.g., \b vs \B). When true, a
  /// boundary rejection for one pattern doesn't
  /// imply all patterns fail at that position.
  has_heterogeneous_boundaries: bool,
  needs_slow_path: bool,
}

#[napi]
impl RegexSet {
  #[napi(constructor)]
  pub fn new(
    patterns: Vec<String>,
    options: Option<Options>,
  ) -> Result<Self> {
    let whole_words = options
      .as_ref()
      .and_then(|o| o.whole_words)
      .unwrap_or(false);
    let unicode_wb = options
      .as_ref()
      .and_then(|o| o.unicode_boundaries)
      .unwrap_or(true);

    let pattern_count = patterns.len() as u32;

    let wrapped: Vec<String> = if whole_words
      && !unicode_wb
    {
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
      let (stripped, mut eb) =
        strip_edge_boundaries(p);

      if whole_words && unicode_wb {
        eb.leading_b = true;
        eb.trailing_b = true;
        eb.leading_big_b = false;
        eb.trailing_big_b = false;
      }

      let (core, verifier) =
        build_verifier(&stripped).map_err(|e| {
          Error::from_reason(format!(
            "Failed to compile pattern {i}: {e}"
          ))
        })?;

      if let Ok(individual) = MetaRegex::new(&core)
      {
        cores.push(core);
        info.push(PatternInfo {
          original_index: i as u32,
          verifier,
          boundaries: eb,
          unicode_wb,
          individual,
        });
      } else {
        let re = match verifier {
          Verifier::Complex(re) => re,
          _ => {
            let fancy_pat =
              ascii_boundary_for_fancy(&stripped);
            fancy_regex::Regex::new(&fancy_pat)
              .map_err(|e| {
                Error::from_reason(format!(
                  "Failed to compile pattern {i}: {e}"
                ))
              })?
          }
        };
        fallbacks.push(FallbackPattern {
          original_index: i as u32,
          regex: re,
          boundaries: eb,
          unicode_wb,
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

    let has_boundaryless_pattern =
      info.iter().any(|pi| !pi.boundaries.has_any());
    let has_heterogeneous_boundaries =
      if info.len() < 2 {
        false
      } else {
        let first = &info[0].boundaries;
        info.iter().any(|pi| {
          pi.boundaries.leading_b
            != first.leading_b
            || pi.boundaries.trailing_b
              != first.trailing_b
            || pi.boundaries.leading_big_b
              != first.leading_big_b
            || pi.boundaries.trailing_big_b
              != first.trailing_big_b
        })
      };
    let needs_slow_path = info.iter().any(|pi| {
      !matches!(&pi.verifier, Verifier::None)
        || pi.boundaries.leading_big_b
        || pi.boundaries.trailing_big_b
    });

    Ok(Self {
      multi,
      info,
      fallbacks,
      pattern_count,
      has_boundaryless_pattern,
      has_heterogeneous_boundaries,
      needs_slow_path,
    })
  }

  #[napi(getter)]
  pub fn pattern_count(&self) -> u32 {
    self.pattern_count
  }

  // ── Core match collection (single source) ──

  /// Collect all verified matches from both the
  /// multi-DFA and fallback patterns. This is the
  /// single source of truth for match logic —
  /// is_match, find_iter, which_match, and
  /// replace_all all delegate here.
  /// Determine the boundary mode for a haystack.
  /// If unicodeBoundaries is on and the text has
  /// Thai/CJK/Lao/Khmer/Myanmar, use UAX#29.
  /// Otherwise use fast inline checks.
  fn boundary_mode(
    &self,
    haystack: &str,
  ) -> BoundaryMode {
    let any_boundaries = self.info.iter().any(
      |pi| pi.boundaries.has_any(),
    ) || self.fallbacks.iter().any(|fb| {
      fb.boundaries.has_any()
    });

    if !any_boundaries {
      return BoundaryMode::Inline {
        unicode: false,
      };
    }

    // Check if any pattern uses unicode boundaries
    let unicode = self
      .info
      .first()
      .map(|pi| pi.unicode_wb)
      .unwrap_or(false);

    if unicode && needs_segmenter(haystack) {
      BoundaryMode::Segmenter {
        bitset: compute_uax29_boundaries(
          haystack,
        ),
      }
    } else {
      BoundaryMode::Inline { unicode }
    }
  }

  fn collect_matches(
    &self,
    haystack: &str,
  ) -> Vec<RawMatch> {
    let mut all: Vec<RawMatch> = Vec::new();
    let mode = self.boundary_mode(haystack);

    if let Some(ref multi) = self.multi {
      if !self.needs_slow_path {
        for m in multi.find_iter(haystack) {
          let pi =
            &self.info[m.pattern().as_usize()];
          if !pi.boundaries.has_any()
            || pi.boundaries.check_with_mode(
              haystack,
              m.start(),
              m.end(),
              &mode,
            )
          {
            all.push((
              pi.original_index,
              m.start(),
              m.end(),
            ));
          }
        }
      } else {
        // Slow path: manual loop with shadowed
        // match recovery on verifier rejection.
        let mut pos = 0;
        while pos <= haystack.len() {
          let input =
            Input::new(haystack).range(pos..);
          match multi.find(input) {
            Some(m) => {
              let dfa_idx =
                m.pattern().as_usize();
              let pi = &self.info[dfa_idx];
              match check_match(
                haystack,
                m.start(),
                m.end(),
                &pi.verifier,
                &pi.boundaries,
                &mode,
              ) {
                Ok(()) => {
                  all.push((
                    pi.original_index,
                    m.start(),
                    m.end(),
                  ));
                  pos = m.end().max(pos + 1);
                }
                Err(ref rej)
                  if self
                    .needs_shadowed_check(rej) =>
                {
                  if let Some(alt) = self
                    .find_shadowed(
                      haystack,
                      m.start(),
                      dfa_idx,
                      &mode,
                    )
                  {
                    all.push(alt);
                    pos = alt.2.max(pos + 1);
                  } else {
                    pos = m.start() + 1;
                  }
                }
                Err(_) => {
                  pos = m.start() + 1;
                }
              }
            }
            None => break,
          }
        }
      }
    }

    // Fallback patterns (fancy-regex).
    for fb in &self.fallbacks {
      let mut pos = 0;
      while pos <= haystack.len() {
        match fb.regex.find_from_pos(haystack, pos)
        {
          Ok(Some(m)) => {
            let passes = !fb.boundaries.has_any()
              || fb.boundaries.check_with_mode(
                haystack,
                m.start(),
                m.end(),
                &mode,
              );
            if passes {
              all.push((
                fb.original_index,
                m.start(),
                m.end(),
              ));
              pos = m.end().max(pos + 1);
            } else {
              pos = m.start() + 1;
            }
          }
          _ => break,
        }
      }
    }

    all
  }

  /// Sort matches and select non-overlapping.
  fn select_non_overlapping(
    all: &mut Vec<RawMatch>,
  ) -> Vec<RawMatch> {
    all.sort_by(|a, b| {
      a.1
        .cmp(&b.1)
        .then_with(|| (b.2 - b.1).cmp(&(a.2 - a.1)))
    });
    let mut selected: Vec<RawMatch> = Vec::new();
    let mut last_end: usize = 0;
    for &(pat, start, end) in all.iter() {
      if start >= last_end {
        selected.push((pat, start, end));
        last_end = end;
      }
    }
    selected
  }

  fn find_shadowed(
    &self,
    haystack: &str,
    at: usize,
    skip: usize,
    mode: &BoundaryMode,
  ) -> Option<RawMatch> {
    for (idx, pi) in self.info.iter().enumerate() {
      if idx == skip {
        continue;
      }
      let input =
        Input::new(haystack).range(at..);
      if let Some(m) = pi.individual.find(input) {
        if m.start() == at
          && check_match(
            haystack,
            m.start(),
            m.end(),
            &pi.verifier,
            &pi.boundaries,
            mode,
          )
          .is_ok()
        {
          return Some((
            pi.original_index,
            m.start(),
            m.end(),
          ));
        }
      }
    }
    None
  }

  fn needs_shadowed_check(
    &self,
    rejection: &Rejection,
  ) -> bool {
    match rejection {
      Rejection::Verifier => true,
      Rejection::Boundary => {
        self.has_boundaryless_pattern
          || self.has_heterogeneous_boundaries
      }
    }
  }

  // ── Internal methods ──────────────────────

  fn _is_match(&self, haystack: &str) -> bool {
    let mode = self.boundary_mode(haystack);

    if let Some(ref multi) = self.multi {
      if !self.needs_slow_path {
        for m in multi.find_iter(haystack) {
          let pi =
            &self.info[m.pattern().as_usize()];
          if !pi.boundaries.has_any()
            || pi.boundaries.check_with_mode(
              haystack,
              m.start(),
              m.end(),
              &mode,
            )
          {
            return true;
          }
        }
      } else {
        let mut pos = 0;
        while pos <= haystack.len() {
          let input =
            Input::new(haystack).range(pos..);
          match multi.find(input) {
            Some(m) => {
              let dfa_idx =
                m.pattern().as_usize();
              let pi = &self.info[dfa_idx];
              match check_match(
                haystack,
                m.start(),
                m.end(),
                &pi.verifier,
                &pi.boundaries,
                &mode,
              ) {
                Ok(()) => return true,
                Err(ref rej)
                  if self
                    .needs_shadowed_check(rej) =>
                {
                  if self
                    .find_shadowed(
                      haystack,
                      m.start(),
                      dfa_idx,
                      &mode,
                    )
                    .is_some()
                  {
                    return true;
                  }
                }
                Err(_) => {}
              }
              pos = m.start() + 1;
            }
            None => break,
          }
        }
      }
    }
    for fb in &self.fallbacks {
      let mut pos = 0;
      while pos <= haystack.len() {
        match fb.regex.find_from_pos(haystack, pos)
        {
          Ok(Some(m)) => {
            let passes = !fb.boundaries.has_any()
              || fb.boundaries.check_with_mode(
                haystack,
                m.start(),
                m.end(),
                &mode,
              );
            if passes {
              return true;
            }
            pos = m.start() + 1;
          }
          _ => break,
        }
      }
    }
    false
  }

  fn _find_iter_packed(
    &self,
    haystack: &str,
  ) -> Uint32Array {
    let mut all = self.collect_matches(haystack);

    if all.is_empty() {
      return Uint32Array::new(Vec::new());
    }

    let selected =
      Self::select_non_overlapping(&mut all);

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

  // ── NAPI entry points ─────────────────────

  #[napi]
  pub fn is_match(&self, haystack: String) -> bool {
    self._is_match(&haystack)
  }

  #[napi(js_name = "_isMatchBuf")]
  pub fn is_match_buf(
    &self,
    haystack: Buffer,
  ) -> Result<bool> {
    let text = std::str::from_utf8(
      haystack.as_ref(),
    )
    .map_err(|e| {
      Error::from_reason(format!(
        "Invalid UTF-8: {e}"
      ))
    })?;
    Ok(self._is_match(text))
  }

  #[napi(js_name = "_findIterPacked")]
  pub fn find_iter_packed(
    &self,
    haystack: String,
  ) -> Uint32Array {
    self._find_iter_packed(&haystack)
  }

  #[napi(js_name = "_findIterPackedBuf")]
  pub fn find_iter_packed_buf(
    &self,
    haystack: Buffer,
  ) -> Result<Uint32Array> {
    let text = std::str::from_utf8(
      haystack.as_ref(),
    )
    .map_err(|e| {
      Error::from_reason(format!(
        "Invalid UTF-8: {e}"
      ))
    })?;
    Ok(self._find_iter_packed(text))
  }

  #[napi]
  pub fn which_match(
    &self,
    haystack: String,
  ) -> Vec<u32> {
    let all = self.collect_matches(&haystack);
    let mut seen = vec![
      false;
      self.pattern_count as usize
    ];
    let mut result = Vec::new();
    for (pat, _, _) in all {
      let idx = pat as usize;
      if !seen[idx] {
        seen[idx] = true;
        result.push(pat);
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

    let mut all = self.collect_matches(&haystack);
    let selected =
      Self::select_non_overlapping(&mut all);

    let mut result = String::with_capacity(
      haystack.len(),
    );
    let mut last: usize = 0;

    for (pat, start, end) in selected {
      result.push_str(&haystack[last..start]);
      result.push_str(&replacements[pat as usize]);
      last = end;
    }
    result.push_str(&haystack[last..]);
    Ok(result)
  }
}

// ─── Benchmark: UAX#29 word boundaries ──────

/// Compute UAX#29 word boundary positions using
/// the unicode-segmentation crate. Returns the
/// set as a sorted Vec of byte offsets.
#[napi(js_name = "_uax29Boundaries")]
pub fn uax29_boundaries(
  haystack: Buffer,
) -> Result<Vec<u32>> {
  let text = std::str::from_utf8(
    haystack.as_ref(),
  )
  .map_err(|e| {
    Error::from_reason(format!(
      "Invalid UTF-8: {e}"
    ))
  })?;

  let mut boundaries = Vec::new();
  let mut offset = 0usize;
  for word in text.unicode_word_indices() {
    boundaries.push(word.0 as u32);
    boundaries.push(
      (word.0 + word.1.len()) as u32,
    );
  }
  // Add 0 and len as boundaries
  if boundaries.is_empty()
    || boundaries[0] != 0
  {
    boundaries.insert(0, 0);
  }
  let len = text.len() as u32;
  if *boundaries.last().unwrap_or(&0) != len {
    boundaries.push(len);
  }
  boundaries.sort_unstable();
  boundaries.dedup();
  Ok(boundaries)
}
