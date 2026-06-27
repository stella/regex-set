// Low-level parser loops maintain byte-offset invariants internally; exported
// offsets and pattern indexes are checked before crossing the JS boundary.
#![allow(
  clippy::arithmetic_side_effects,
  clippy::bool_to_int_with_if,
  clippy::collapsible_if,
  clippy::doc_markdown,
  clippy::indexing_slicing,
  clippy::integer_division,
  clippy::items_after_statements,
  clippy::manual_map,
  clippy::match_same_arms,
  clippy::missing_const_for_fn,
  clippy::option_if_let_else,
  clippy::redundant_closure,
  clippy::string_slice,
  clippy::struct_excessive_bools,
  clippy::too_many_lines,
  clippy::trivially_copy_pass_by_ref,
  clippy::use_self
)]

use regex_automata::{
  Anchored, Input, Match as AutomataMatch,
  dfa::{Automaton, dense, regex::Regex as DfaRegex},
  meta::Regex as MetaRegex,
};
use std::{error, fmt, panic};
use unicode_segmentation::UnicodeSegmentation;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
  reason: String,
}

impl Error {
  fn from_reason(reason: impl Into<String>) -> Self {
    Self {
      reason: reason.into(),
    }
  }
}

impl fmt::Display for Error {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str(&self.reason)
  }
}

impl error::Error for Error {}

const FANCY_BACKTRACK_LIMIT: usize = 1_000_000;
const FALLBACK_ALT_CHUNK_SIZE: usize = 128;
const FALLBACK_MIN_CONTEXT: usize = 256;
const FALLBACK_MAX_CONTEXT: usize = 8_192;
const PREPARED_MAGIC: &[u8; 8] = b"st-rx01\0";
const PREPARED_SCHEMA_VERSION: u8 = 1;
const PREPARED_KIND_META: u8 = 0;
const PREPARED_KIND_DENSE: u8 = 1;
const PREPARED_ARTIFACT_MAX_COUNT: usize = 2;
const PREPARED_DENSE_DFA_MAX_BYTES: usize = 1024 * 1024;
const PREPARED_DENSE_DETERMINIZE_MAX_BYTES: usize = 8 * 1024 * 1024;
const PREPARED_FINGERPRINT_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const PREPARED_FINGERPRINT_PRIME: u64 = 0x0000_0100_0000_01b3;

fn u32_overflow_error(label: &str, value: usize) -> Error {
  Error::from_reason(format!("{label} exceeds u32 range: {value}"))
}

fn usize_to_u32(label: &str, value: usize) -> Result<u32> {
  u32::try_from(value).map_err(|_| u32_overflow_error(label, value))
}

fn pattern_index_to_usize(pattern: u32) -> Result<usize> {
  usize::try_from(pattern).map_err(|_| {
    Error::from_reason(format!("Pattern index is not addressable: {pattern}"))
  })
}

fn build_fancy_regex(
  pattern: &str,
) -> std::result::Result<fancy_regex::Regex, String> {
  fancy_regex::RegexBuilder::new(pattern)
    .backtrack_limit(FANCY_BACKTRACK_LIMIT)
    .build()
    .map_err(|e| format!("{e}"))
}

/// Safe wrapper for fancy-regex calls. Historically
/// older fancy-regex versions could panic on certain
/// pattern/input combinations; the guard remains as
/// defence in depth and converts any panic or error
/// (e.g. backtracking-limit exceeded) to `None`.
/// Returns (start, end) byte positions.
fn safe_fancy_find(
  re: &fancy_regex::Regex,
  haystack: &str,
  pos: usize,
) -> Option<(usize, usize)> {
  safe_fancy_find_result(re, haystack, pos).ok().flatten()
}

fn safe_fancy_find_result(
  re: &fancy_regex::Regex,
  haystack: &str,
  pos: usize,
) -> std::result::Result<Option<(usize, usize)>, ()> {
  panic::catch_unwind(panic::AssertUnwindSafe(|| {
    re.find_from_pos(haystack, pos)
  }))
  .map_err(|_| ())?
  .map(|m| m.map(|m| (m.start(), m.end())))
  .map_err(|_| ())
}

fn next_char_pos(haystack: &str, pos: usize) -> usize {
  if pos >= haystack.len() {
    return pos + 1;
  }
  let mut next = pos + 1;
  while next < haystack.len() && !haystack.is_char_boundary(next) {
    next += 1;
  }
  next
}

fn prev_char_pos(haystack: &str, pos: usize) -> usize {
  if pos == 0 {
    return 0;
  }
  let mut prev = pos - 1;
  while prev > 0 && !haystack.is_char_boundary(prev) {
    prev -= 1;
  }
  prev
}

/// Options for constructing a `RegexSet`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Options {
  pub whole_words: bool,
  pub unicode_boundaries: bool,
}

impl Default for Options {
  fn default() -> Self {
    Self {
      whole_words: false,
      unicode_boundaries: true,
    }
  }
}

/// A single match returned by search methods.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Match {
  /// Index of the pattern that matched.
  pub pattern: u32,
  /// Start offset (UTF-16 code units).
  pub start: u32,
  /// End offset (exclusive, UTF-16 code units).
  pub end: u32,
}

// ─── UTF-16 offset translation ────────────────

fn byte_span_utf16_len(bytes: &[u8]) -> Result<u32> {
  let mut count = 0u32;
  let mut i = 0;
  while i < bytes.len() {
    let b = bytes[i];
    let units = if b < 0xF0 { 1 } else { 2 };
    count = count
      .checked_add(units)
      .ok_or_else(|| Error::from_reason("UTF-16 offset exceeds u32 range"))?;
    if b < 0x80 {
      i += 1;
    } else if b < 0xE0 {
      i += 2;
    } else if b < 0xF0 {
      i += 3;
    } else {
      i += 4;
    }
  }
  Ok(count)
}

// ─── Word boundary verification ─────────────

fn is_word_char_unicode(ch: char) -> bool {
  ch.is_alphanumeric() || ch == '_'
}

fn is_word_char_ascii(ch: char) -> bool {
  ch.is_ascii_alphanumeric() || ch == '_'
}

/// Check word boundary at a byte position.
fn check_word_boundary(haystack: &str, byte_pos: usize, unicode: bool) -> bool {
  let is_wc = if unicode {
    is_word_char_unicode
  } else {
    is_word_char_ascii
  };

  let before = if byte_pos == 0 {
    false
  } else {
    haystack
      .get(..byte_pos)
      .and_then(|prefix| prefix.chars().next_back())
      .is_some_and(is_wc)
  };
  let after = if byte_pos >= haystack.len() {
    false
  } else {
    haystack
      .get(byte_pos..)
      .and_then(|suffix| suffix.chars().next())
      .is_some_and(is_wc)
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
      let cp = ((u32::from(b) & 0x0F) << 12)
        | ((u32::from(bytes[i + 1]) & 0x3F) << 6)
        | (u32::from(bytes[i + 2]) & 0x3F);
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
        || (0xAC00..=0xD7AF).contains(&cp)
      // Hangul
      {
        return true;
      }
      i += 3;
      continue;
    }
    // 4-byte: CJK Ext B+ (U+20000+)
    if b >= 0xF0 && i + 3 < bytes.len() {
      let cp = ((u32::from(b) & 0x07) << 18)
        | ((u32::from(bytes[i + 1]) & 0x3F) << 12)
        | ((u32::from(bytes[i + 2]) & 0x3F) << 6)
        | (u32::from(bytes[i + 3]) & 0x3F);
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
      bits: vec![0u64; len.div_ceil(64)],
    }
  }

  fn set(&mut self, pos: usize) {
    if pos < self.bits.len() * 64 {
      self.bits[pos / 64] |= 1u64 << (pos % 64);
    }
  }

  fn contains(&self, pos: usize) -> bool {
    pos < self.bits.len() * 64
      && self.bits[pos / 64] & (1u64 << (pos % 64)) != 0
  }
}

/// Compute UAX#29 word boundaries as a bit set.
/// No sort needed: unicode_word_indices returns
/// positions in order. O(1) lookup per position.
fn compute_uax29_boundaries(haystack: &str) -> BoundaryBitSet {
  use unicode_segmentation::UnicodeSegmentation;
  let mut bs = BoundaryBitSet::new(haystack.len() + 1);
  bs.set(0);
  bs.set(haystack.len());
  for (offset, word) in haystack.unicode_word_indices() {
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
      BoundaryMode::Segmenter { bitset } => bitset.contains(pos),
      BoundaryMode::Inline { .. } => false,
    }
  }
}

/// Check if a pattern has internal `\b` or `\B`
/// (i.e., not at the edges). These cause DFA state
/// explosion when combined with large alternations
/// in a multi-pattern DFA.
fn has_internal_boundary(pattern: &str) -> bool {
  let bytes = pattern.as_bytes();
  let mut in_class = false;
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'\\' && i + 1 < bytes.len() {
      if !in_class && (bytes[i + 1] == b'b' || bytes[i + 1] == b'B') {
        return true;
      }
      // Skip escaped char
      i += 2;
      continue;
    }
    if bytes[i] == b'[' {
      in_class = true;
    }
    if bytes[i] == b']' {
      in_class = false;
    }
    i += 1;
  }
  false
}

/// Replace internal `\b` / `\B` with
/// `(?-u:\b)` / `(?-u:\B)` to prevent DFA state
/// explosion. Skips character classes where `\b`
/// means backspace.
///
/// Uses string slices (not byte→char casts) to
/// preserve multi-byte UTF-8 characters correctly.
fn ascii_internal_boundaries(pattern: &str) -> String {
  let mut result = String::with_capacity(pattern.len() + 32);
  let bytes = pattern.as_bytes();
  let mut seg_start = 0;
  let mut in_class = false;
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'\\' && i + 1 < bytes.len() {
      let next = bytes[i + 1];
      if !in_class && (next == b'b' || next == b'B') {
        result.push_str(&pattern[seg_start..i]);
        result.push_str("(?-u:\\");
        result.push(char::from(next)); // b/B are ASCII
        result.push(')');
        i += 2;
        seg_start = i;
        continue;
      }
      // Skip escaped pair
      i += 2;
      continue;
    }
    if bytes[i] == b'[' {
      in_class = true;
    }
    if bytes[i] == b']' {
      in_class = false;
    }
    i += 1;
  }
  result.push_str(&pattern[seg_start..]);
  result
}

/// Check if a pattern contains any non-ASCII bytes.
/// When true, internal `\b` cannot be safely replaced
/// with `(?-u:\b)` because ASCII word boundaries
/// don't recognise non-ASCII word characters (é, ü,
/// etc.), causing false negatives.
fn has_non_ascii(pattern: &str) -> bool {
  !pattern.is_ascii()
}

fn bracket_class_is_word_like(s: &str) -> bool {
  let Some(inner) = s.strip_prefix('[').and_then(|v| v.strip_suffix(']'))
  else {
    return false;
  };
  !inner.starts_with('^')
    && inner
      .chars()
      .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn starts_with_word_like_token(s: &str) -> bool {
  if s.starts_with("\\w") || s.starts_with("\\d") {
    return true;
  }
  if s.starts_with("\\p{L}")
    || s.starts_with("\\p{N}")
    || s.starts_with("\\p{Alphabetic}")
    || s.starts_with("\\p{Numeric}")
    || s.starts_with("\\p{Letter}")
    || s.starts_with("\\p{Number}")
  {
    return true;
  }
  if s
    .chars()
    .next()
    .is_some_and(|ch| ch.is_alphanumeric() || ch == '_')
  {
    return true;
  }
  if !s.starts_with('[') {
    return false;
  }
  let Some(end) = s.find(']') else {
    return false;
  };
  bracket_class_is_word_like(&s[..=end])
}

fn strip_trailing_quantifier(s: &str) -> &str {
  if s.ends_with('?') || s.ends_with('+') || s.ends_with('*') {
    return &s[..s.len() - 1];
  }

  let Some(close) = s.strip_suffix('}') else {
    return s;
  };
  let Some(open) = close.rfind('{') else {
    return s;
  };
  let quantifier = &close[open + 1..];
  if !quantifier
    .chars()
    .all(|ch| ch.is_ascii_digit() || ch == ',')
  {
    return s;
  }
  &close[..open]
}

fn ends_with_word_like_token(s: &str) -> bool {
  let s = strip_trailing_quantifier(s);
  if s.ends_with("\\w") || s.ends_with("\\d") {
    return true;
  }
  if s.ends_with("\\p{L}")
    || s.ends_with("\\p{N}")
    || s.ends_with("\\p{Alphabetic}")
    || s.ends_with("\\p{Numeric}")
    || s.ends_with("\\p{Letter}")
    || s.ends_with("\\p{Number}")
  {
    return true;
  }
  if s
    .chars()
    .next_back()
    .is_some_and(|ch| ch.is_alphanumeric() || ch == '_')
  {
    return true;
  }
  if !s.ends_with(']') {
    return false;
  }
  let Some(open) = s.rfind('[') else {
    return false;
  };
  bracket_class_is_word_like(&s[open..])
}

/// Strip leading/trailing `\b` or `\B` from a
/// pattern string.
fn strip_edge_boundaries(pattern: &str) -> (String, EdgeBoundaries) {
  let bytes = pattern.as_bytes();
  let mut start = 0;
  let mut end = bytes.len();
  let mut eb = EdgeBoundaries::default();

  // Leading \b or \B
  if end - start >= 2
    && bytes[start] == b'\\'
    && (bytes[start + 1] == b'b' || bytes[start + 1] == b'B')
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
    && (bytes[end - 1] == b'b' || bytes[end - 1] == b'B')
    && bytes[end - 2] == b'\\'
  {
    let mut num_bs = 0usize;
    let mut k = end - 2;
    while k > start && bytes[k - 1] == b'\\' {
      num_bs += 1;
      k -= 1;
    }
    if num_bs.is_multiple_of(2) {
      if bytes[end - 1] == b'b' {
        eb.trailing_b = true;
      } else {
        eb.trailing_big_b = true;
      }
      end -= 2;
    }
  }

  const LEADING_NOT_WORD: &str = "(?<!\\w)";
  if pattern[start..end].starts_with(LEADING_NOT_WORD)
    && starts_with_word_like_token(
      &pattern[start + LEADING_NOT_WORD.len()..end],
    )
  {
    eb.leading_b = true;
    start += LEADING_NOT_WORD.len();
  }

  const TRAILING_NOT_WORD: &str = "(?!\\w)";
  if pattern[start..end].ends_with(TRAILING_NOT_WORD)
    && ends_with_word_like_token(&pattern[start..end - TRAILING_NOT_WORD.len()])
  {
    eb.trailing_b = true;
    end -= TRAILING_NOT_WORD.len();
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
          check_word_boundary(haystack, pos, *unicode)
        }
        BoundaryMode::Segmenter { .. } => mode.is_boundary(pos),
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
  AsciiLowercase,
  AsciiUppercase,
  Lowercase,
  Uppercase,
  /// Small character set expanded at construction
  /// time. Sorted for binary search.
  CharSet(Vec<char>),
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
      CharClass::AsciiLowercase => ch.is_ascii_lowercase(),
      CharClass::AsciiUppercase => ch.is_ascii_uppercase(),
      CharClass::Lowercase => ch.is_lowercase(),
      CharClass::Uppercase => ch.is_uppercase(),
      CharClass::CharSet(set) => set.binary_search(&ch).is_ok(),
      CharClass::Regex(re) => {
        let mut buf = [0u8; 4];
        re.is_match(ch.encode_utf8(&mut buf))
      }
    }
  }

  fn from_str(s: &str) -> std::result::Result<Self, String> {
    match s {
      "\\d" | "[0-9]" => Ok(CharClass::Digit),
      "\\w" | "[a-zA-Z0-9_]" => Ok(CharClass::WordChar),
      "\\s" | "[\\t\\n\\r ]" => Ok(CharClass::Whitespace),
      "\\p{L}" | "\\p{Alphabetic}" | "\\p{Letter}" => Ok(CharClass::Alpha),
      "\\p{N}" | "\\p{Numeric}" | "\\p{Number}" => Ok(CharClass::Numeric),
      "[a-z]" => Ok(CharClass::AsciiLowercase),
      "[A-Z]" => Ok(CharClass::AsciiUppercase),
      "\\p{Ll}" | "\\p{Lowercase}" => Ok(CharClass::Lowercase),
      "\\p{Lu}" | "\\p{Uppercase}" => Ok(CharClass::Uppercase),
      _ => {
        // Try expanding a simple bracket expression
        // into a sorted char set for O(log n) lookup
        // instead of a full regex engine call.
        if let Some(chars) = expand_bracket_expr(s) {
          return Ok(CharClass::CharSet(chars));
        }
        let re = regex::Regex::new(s).map_err(|e| format!("{e}"))?;
        Ok(CharClass::Regex(re))
      }
    }
  }
}

/// Try to expand a bracket expression like `[a-zA-Z]`
/// into a sorted `Vec<char>`. Returns `None` if the
/// expression is too complex or too large (> 256 chars).
/// Only handles ASCII ranges and literal chars.
fn expand_bracket_expr(s: &str) -> Option<Vec<char>> {
  let bytes = s.as_bytes();
  if bytes.len() < 3 || bytes[0] != b'[' || bytes[bytes.len() - 1] != b']' {
    return None;
  }
  let inner = &s[1..s.len() - 1];
  // Reject negated classes — [^...] must go through
  // the full regex engine for correct semantics.
  // Also reject nested brackets, escapes, non-ASCII.
  if !inner.is_ascii()
    || inner.starts_with('^')
    || inner.contains('[')
    || inner.contains(']')
    || inner.contains('\\')
  {
    return None;
  }
  let mut chars: Vec<char> = Vec::new();
  let ibytes = inner.as_bytes();
  let mut i = 0;
  // Note: a trailing `-` (e.g. `[a-z-]`) is handled
  // correctly by the loop structure. When `-` is at a
  // position where `i + 2 >= len`, the range guard
  // fails and `-` falls through to the literal branch.
  // This matches regex crate semantics.
  while i < ibytes.len() {
    if i + 2 < ibytes.len() && ibytes[i + 1] == b'-' {
      let lo = ibytes[i];
      let hi = ibytes[i + 2];
      if lo > hi {
        return None;
      }
      let count = usize::from(hi - lo) + 1;
      if chars.len() + count > 256 {
        return None;
      }
      for c in lo..=hi {
        chars.push(char::from(c));
      }
      i += 3;
    } else {
      chars.push(char::from(ibytes[i]));
      i += 1;
    }
  }
  if chars.is_empty() || chars.len() > 256 {
    return None;
  }
  chars.sort_unstable();
  chars.dedup();
  Some(chars)
}

struct CharCheck {
  class: CharClass,
  negated: bool,
}

impl CharCheck {
  fn test(&self, haystack: &str, pos: usize) -> bool {
    if pos >= haystack.len() {
      return self.negated;
    }
    let Some(ch) = haystack.get(pos..).and_then(|value| value.chars().next())
    else {
      return self.negated;
    };
    let matches = self.class.matches_char(ch);
    if self.negated { !matches } else { matches }
  }

  fn test_before(&self, haystack: &str, pos: usize) -> bool {
    if pos == 0 {
      return self.negated;
    }
    let Some(ch) = haystack
      .get(..pos)
      .and_then(|value| value.chars().next_back())
    else {
      return self.negated;
    };
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

fn extract_leading_lookbehind(pattern: &str) -> Option<(String, bool, String)> {
  let (prefix, negated) = if pattern.starts_with("(?<!") {
    ("(?<!", true)
  } else if pattern.starts_with("(?<=") {
    ("(?<=", false)
  } else {
    return None;
  };
  let end = find_matching_paren(pattern, 0)?;
  let content = pattern[prefix.len()..end].to_string();
  let rest = pattern[end + 1..].to_string();
  Some((content, negated, rest))
}

fn extract_trailing_lookahead(pattern: &str) -> Option<(String, String, bool)> {
  let start = find_last_lookahead_start(pattern)?;
  let end = pattern.len() - 1;
  let prefix = &pattern[start..start + 3];
  if prefix != "(?!" && prefix != "(?=" {
    return None;
  }
  let prefix_len = 3;
  let negated = &pattern[start + 2..start + 3] == "!";
  let content = pattern[start + prefix_len..end].to_string();
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
) -> std::result::Result<(String, Verifier), String> {
  if !has_lookaround(pattern) {
    return Ok((pattern.to_string(), Verifier::None));
  }

  let mut core = pattern.to_string();
  let mut pre: Option<CharCheck> = None;
  let mut post: Option<CharCheck> = None;

  if let Some((content, negated, rest)) = extract_leading_lookbehind(&core) {
    if is_simple_char_class(&content) {
      let class = CharClass::from_str(&content)?;
      pre = Some(CharCheck { class, negated });
      core = rest;
    }
  }

  if let Some((rest, content, negated)) = extract_trailing_lookahead(&core) {
    if is_simple_char_class(&content) {
      let class = CharClass::from_str(&content)?;
      post = Some(CharCheck { class, negated });
      core = rest;
    }
  }

  if !has_lookaround(&core) && (pre.is_some() || post.is_some()) {
    return Ok((core, Verifier::Inline(InlineCheck { pre, post })));
  }

  // Complex lookaround → fancy-regex fallback.
  // ascii_boundary_for_fancy() expresses ASCII \b
  // as lookaround on [a-zA-Z0-9_].
  let core_stripped = strip_lookaround_str(pattern);
  let fancy_pat = ascii_boundary_for_fancy(pattern);
  let verifier = build_fancy_regex(&fancy_pat)?;

  Ok((core_stripped, Verifier::Complex(verifier)))
}

impl Verifier {
  fn check(&self, haystack: &str, start: usize, end: usize) -> bool {
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
        let ctx_start = start.saturating_sub(20);
        let ctx_end = (end + 20).min(haystack.len());
        let ctx_start = floor_char_boundary(haystack, ctx_start);
        let ctx_end = ceil_char_boundary(haystack, ctx_end);
        let window = &haystack[ctx_start..ctx_end];
        let offset = start - ctx_start;
        // Must match exactly at offset.
        safe_fancy_find(re, window, offset)
          .as_ref()
          .is_some_and(|&(s, _)| s == offset)
      }
    }
  }
}

// ─── String helpers ───────────────────────────

fn strip_lookaround_str(pattern: &str) -> String {
  let mut result = pattern.to_string();
  while result.starts_with("(?<=") || result.starts_with("(?<!") {
    if let Some(end) = find_matching_paren(&result, 0) {
      result = result[end + 1..].to_string();
    } else {
      break;
    }
  }
  loop {
    let trimmed = result.trim_end();
    if trimmed.ends_with(')') {
      if let Some(start) = find_last_lookahead_start(trimmed) {
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

fn strip_fallback_candidate_str(pattern: &str) -> String {
  strip_zero_width_assertions(pattern)
}

fn strip_zero_width_assertions(pattern: &str) -> String {
  let bytes = pattern.as_bytes();
  let mut result = String::with_capacity(pattern.len());
  let mut seg_start = 0;
  let mut in_class = false;
  let mut escaped = false;
  let mut i = 0;

  while i < bytes.len() {
    if escaped {
      escaped = false;
      i += 1;
      continue;
    }

    match bytes[i] {
      b'\\' => {
        if !in_class
          && i + 1 < bytes.len()
          && (bytes[i + 1] == b'b' || bytes[i + 1] == b'B')
        {
          result.push_str(&pattern[seg_start..i]);
          i += 2;
          seg_start = i;
          continue;
        }
        escaped = true;
        i += 1;
      }
      b'[' if !in_class => {
        in_class = true;
        i += 1;
      }
      b']' if in_class => {
        in_class = false;
        i += 1;
      }
      b'(' if !in_class && is_lookaround_at(bytes, i) => {
        if let Some(end) = find_matching_paren(pattern, i) {
          result.push_str(&pattern[seg_start..i]);
          i = end + 1;
          seg_start = i;
        } else {
          i += 1;
        }
      }
      _ => i += 1,
    }
  }

  result.push_str(&pattern[seg_start..]);
  result
}

fn split_large_alternation(
  pattern: &str,
  chunk_size: usize,
) -> Option<Vec<String>> {
  let bytes = pattern.as_bytes();
  let mut best: Option<(usize, usize, Vec<String>)> = None;
  let mut in_class = false;
  let mut escaped = false;
  let mut i = 0;

  while i < bytes.len() {
    if escaped {
      escaped = false;
      i += 1;
      continue;
    }

    match bytes[i] {
      b'\\' => {
        escaped = true;
        i += 1;
      }
      b'[' if !in_class => {
        in_class = true;
        i += 1;
      }
      b']' if in_class => {
        in_class = false;
        i += 1;
      }
      b'(' if !in_class && is_negative_lookaround_at(bytes, i) => {
        if let Some(end) = find_matching_paren(pattern, i) {
          i = end + 1;
        } else {
          i += 1;
        }
      }
      b'('
        if !in_class
          && i + 2 < bytes.len()
          && bytes[i + 1] == b'?'
          && bytes[i + 2] == b':' =>
      {
        if let Some(end) = find_matching_paren(pattern, i) {
          let alts = split_top_level_alternatives(&pattern[i + 3..end]);
          if alts.len() > chunk_size
            && best
              .as_ref()
              .is_none_or(|(_, _, best_alts)| alts.len() > best_alts.len())
          {
            best = Some((i + 3, end, alts));
          }
          i += 3;
        } else {
          i += 1;
        }
      }
      _ => i += 1,
    }
  }

  let (inner_start, inner_end, alts) = best?;
  let mut chunks = Vec::new();
  for chunk in alts.chunks(chunk_size) {
    let mut pat = String::with_capacity(pattern.len());
    pat.push_str(&pattern[..inner_start]);
    pat.push_str(&chunk.join("|"));
    pat.push_str(&pattern[inner_end..]);
    chunks.push(pat);
  }
  Some(chunks)
}

fn split_top_level_alternatives(s: &str) -> Vec<String> {
  let bytes = s.as_bytes();
  let mut out = Vec::new();
  let mut start = 0;
  let mut depth = 0i32;
  let mut in_class = false;
  let mut escaped = false;
  let mut i = 0;

  while i < bytes.len() {
    if escaped {
      escaped = false;
      i += 1;
      continue;
    }

    match bytes[i] {
      b'\\' => {
        escaped = true;
      }
      b'[' if !in_class => {
        in_class = true;
      }
      b']' if in_class => {
        in_class = false;
      }
      b'(' if !in_class => {
        depth += 1;
      }
      b')' if !in_class => {
        depth -= 1;
      }
      b'|' if !in_class && depth == 0 => {
        out.push(s[start..i].to_string());
        start = i + 1;
      }
      _ => {}
    }
    i += 1;
  }

  out.push(s[start..].to_string());
  out
}

fn is_lookaround_at(bytes: &[u8], i: usize) -> bool {
  if i + 2 >= bytes.len() || bytes[i] != b'(' || bytes[i + 1] != b'?' {
    return false;
  }
  bytes[i + 2] == b'='
    || bytes[i + 2] == b'!'
    || (i + 3 < bytes.len()
      && bytes[i + 2] == b'<'
      && (bytes[i + 3] == b'=' || bytes[i + 3] == b'!'))
}

fn is_negative_lookaround_at(bytes: &[u8], i: usize) -> bool {
  if i + 2 >= bytes.len() || bytes[i] != b'(' || bytes[i + 1] != b'?' {
    return false;
  }
  bytes[i + 2] == b'!'
    || (i + 3 < bytes.len() && bytes[i + 2] == b'<' && bytes[i + 3] == b'!')
}

fn find_matching_paren(s: &str, start: usize) -> Option<usize> {
  let bytes = s.as_bytes();
  let mut depth = 0;
  let mut i = start;
  let mut escaped = false;
  let mut in_class = false;
  while i < bytes.len() {
    if escaped {
      escaped = false;
      i += 1;
      continue;
    }
    match bytes[i] {
      b'\\' => escaped = true,
      b'[' if !in_class => in_class = true,
      b']' if in_class => in_class = false,
      b'(' if !in_class => depth += 1,
      b')' if !in_class => {
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

fn find_last_lookahead_start(s: &str) -> Option<usize> {
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
            && (bytes[i + 2] == b'=' || bytes[i + 2] == b'!')
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

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
  while i > 0 && !s.is_char_boundary(i) {
    i -= 1;
  }
  i
}

fn ceil_char_boundary(s: &str, mut i: usize) -> usize {
  while i < s.len() && !s.is_char_boundary(i) {
    i += 1;
  }
  i
}

const W: &str = "[a-zA-Z0-9_]";

fn ascii_boundary_for_fancy(s: &str) -> String {
  let b = format!("(?:(?<={W})(?!{W})|(?<!{W})(?={W}))");
  let big_b = format!("(?:(?<={W})(?={W})|(?<!{W})(?!{W}))");
  s.replace("(?-u:\\b)", &b).replace("(?-u:\\B)", &big_b)
}

fn restore_edge_boundaries(
  pattern: &str,
  boundaries: &EdgeBoundaries,
) -> String {
  let mut restored = String::with_capacity(pattern.len() + 4);
  if boundaries.leading_b {
    restored.push_str("\\b");
  }
  if boundaries.leading_big_b {
    restored.push_str("\\B");
  }
  restored.push_str(pattern);
  if boundaries.trailing_b {
    restored.push_str("\\b");
  }
  if boundaries.trailing_big_b {
    restored.push_str("\\B");
  }
  restored
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
  pi: &PatternInfo,
  mode: &BoundaryMode,
) -> std::result::Result<(), Rejection> {
  if pi.boundaries.has_any()
    && !pi.boundaries.check_with_mode(haystack, start, end, mode)
  {
    return Err(Rejection::Boundary);
  }
  if !pi.verifier.check(haystack, start, end) {
    return Err(Rejection::Verifier);
  }
  // Internal \b was replaced with (?-u:\b) in the
  // multi-DFA. Verify the match against the individual
  // pattern which has the original Unicode \b.
  if pi.has_internal_b {
    let Some(individual) = &pi.individual else {
      return Err(Rejection::Verifier);
    };
    let input = Input::new(haystack).range(start..);
    match individual.find(input) {
      Some(m) if m.start() == start && m.end() == end => Ok(()),
      _ => Err(Rejection::Verifier),
    }
  } else {
    Ok(())
  }
}

/// Try the fancy-regex fallback after a verifier
/// rejection. Returns `Some((start, end))` if fancy-regex
/// found a valid backtracked match at the DFA's start
/// position that also passes boundary and internal-\b
/// checks.
fn try_fancy_fallback(
  pi: &PatternInfo,
  haystack: &str,
  dfa_start: usize,
  mode: &BoundaryMode,
) -> Option<(usize, usize)> {
  let re = pi.fancy_fallback.as_ref()?;
  let (s, e) = safe_fancy_find(re, haystack, dfa_start)?;
  if s != dfa_start {
    return None;
  }
  if pi.boundaries.has_any()
    && !pi.boundaries.check_with_mode(haystack, s, e, mode)
  {
    return None;
  }
  // Verify Unicode \b at start. pi.individual has
  // no lookahead so it greedily overshoots past the
  // backtracked end. Start-only check suffices.
  if pi.has_internal_b {
    let individual = pi.individual.as_ref()?;
    let inp = Input::new(haystack).range(s..);
    individual.find(inp).filter(|im| im.start() == s)?;
  }
  Some((s, e))
}

fn try_shorter_verified_match(
  pi: &PatternInfo,
  haystack: &str,
  start: usize,
  end: usize,
  mode: &BoundaryMode,
) -> Option<(usize, usize)> {
  if !matches!(pi.verifier, Verifier::Inline(_)) {
    return None;
  }

  let mut candidate_end = prev_char_pos(haystack, end);
  let individual = pi.individual.as_ref()?;
  while candidate_end > start {
    let input = Input::new(haystack)
      .range(start..candidate_end)
      .anchored(Anchored::Yes);
    if let Some(m) = individual.find(input) {
      let boundary_ok = !pi.boundaries.has_any()
        || pi
          .boundaries
          .check_with_mode(haystack, start, candidate_end, mode);
      if m.start() == start
        && m.end() == candidate_end
        && boundary_ok
        && pi.verifier.check(haystack, start, candidate_end)
      {
        return Some((start, candidate_end));
      }
    }
    candidate_end = prev_char_pos(haystack, candidate_end);
  }

  None
}

fn try_verifier_fallback(
  pi: &PatternInfo,
  haystack: &str,
  start: usize,
  end: usize,
  mode: &BoundaryMode,
) -> Option<(usize, usize)> {
  try_fancy_fallback(pi, haystack, start, mode)
    .or_else(|| try_shorter_verified_match(pi, haystack, start, end, mode))
}

fn verify_fallback_at(
  fb: &FallbackPattern,
  haystack: &str,
  start: usize,
  candidate_end: usize,
  mode: &BoundaryMode,
) -> Option<RawMatch> {
  let ctx_start =
    floor_char_boundary(haystack, start.saturating_sub(fb.context));
  let ctx_end = ceil_char_boundary(
    haystack,
    (candidate_end + fb.context).min(haystack.len()),
  );
  let window = &haystack[ctx_start..ctx_end];
  let offset = start - ctx_start;
  let (ms, me) = safe_fancy_find(&fb.regex, window, offset)?;
  if ms != offset {
    return None;
  }
  let ms = ctx_start + ms;
  let me = ctx_start + me;
  let passes = !fb.boundaries.has_any()
    || fb.boundaries.check_with_mode(haystack, ms, me, mode);
  passes.then_some((fb.original_index, ms, me))
}

// ─── Engine ───────────────────────────────────

struct PatternInfo {
  original_index: u32,
  verifier: Verifier,
  boundaries: EdgeBoundaries,
  individual: Option<MetaRegex>,
  /// Pattern had internal `\b`/`\B` replaced with
  /// `(?-u:\b)` in the multi-DFA. Matches must be
  /// verified against `individual` (which has the
  /// original Unicode `\b`).
  has_internal_b: bool,
  /// Full pattern with lookaround for backtracking
  /// fallback. When the DFA finds a greedy match
  /// that the inline verifier rejects (e.g., `\s*`
  /// overshoots past a valid match and the trailing
  /// lookahead fails), fancy-regex can backtrack
  /// the quantifier to find the shorter valid match.
  fancy_fallback: Option<fancy_regex::Regex>,
}

struct FallbackPattern {
  original_index: u32,
  regex: fancy_regex::Regex,
  boundaries: EdgeBoundaries,
  candidate: Option<MetaRegex>,
  context: usize,
}

/// A verified match: (original_pattern_index,
/// byte_start, byte_end).
type RawMatch = (u32, usize, usize);

enum MultiRegex {
  Meta(MetaRegex),
  Dense(Box<DfaRegex>),
}

impl MultiRegex {
  fn find(&self, input: Input<'_>) -> Option<AutomataMatch> {
    match self {
      Self::Meta(re) => re.find(input),
      Self::Dense(re) => re.find(input),
    }
  }

  fn for_each_match(
    &self,
    haystack: &str,
    mut callback: impl FnMut(AutomataMatch),
  ) {
    match self {
      Self::Meta(re) => {
        for m in re.find_iter(haystack) {
          callback(m);
        }
      }
      Self::Dense(re) => {
        for m in re.find_iter(haystack) {
          callback(m);
        }
      }
    }
  }

  fn any_match(
    &self,
    haystack: &str,
    mut predicate: impl FnMut(AutomataMatch) -> bool,
  ) -> bool {
    match self {
      Self::Meta(re) => {
        for m in re.find_iter(haystack) {
          if predicate(m) {
            return true;
          }
        }
      }
      Self::Dense(re) => {
        for m in re.find_iter(haystack) {
          if predicate(m) {
            return true;
          }
        }
      }
    }
    false
  }
}

#[derive(Debug)]
struct PreparedMultiArtifact {
  fingerprint: u64,
  kind: PreparedMultiKind,
}

#[derive(Debug)]
enum PreparedMultiKind {
  Meta,
  Dense { forward: Vec<u8>, reverse: Vec<u8> },
}

enum PreparedMode {
  None,
  Capture {
    artifacts: Vec<PreparedMultiArtifact>,
  },
  Load {
    artifacts: Vec<PreparedMultiArtifact>,
    next: usize,
  },
}

impl PreparedMode {
  fn decode(bytes: &[u8]) -> Result<Self> {
    let artifacts = decode_prepared_artifacts(bytes)?;
    Ok(Self::Load { artifacts, next: 0 })
  }

  fn finish(self) -> Result<Vec<u8>> {
    match self {
      Self::None => Ok(Vec::new()),
      Self::Capture { artifacts } => encode_prepared_artifacts(&artifacts),
      Self::Load { artifacts, next } => {
        if next == artifacts.len() {
          return Ok(Vec::new());
        }
        Err(Error::from_reason("Unused prepared regex artifacts"))
      }
    }
  }

  fn next_loaded(
    &mut self,
    fingerprint: u64,
    expected_pattern_count: usize,
  ) -> Result<Option<MultiRegex>> {
    let Self::Load { artifacts, next } = self else {
      return Ok(None);
    };
    let artifact = artifacts
      .get(*next)
      .ok_or_else(|| Error::from_reason("Missing prepared regex artifact"))?;
    if artifact.fingerprint != fingerprint {
      return Err(Error::from_reason("Prepared regex artifact mismatch"));
    }
    *next += 1;
    match &artifact.kind {
      PreparedMultiKind::Meta => Ok(None),
      PreparedMultiKind::Dense { forward, reverse } => {
        dense_regex_from_bytes(forward, reverse, expected_pattern_count)
          .map(Some)
      }
    }
  }

  fn push_captured(&mut self, artifact: PreparedMultiArtifact) {
    if let Self::Capture { artifacts } = self {
      artifacts.push(artifact);
    }
  }
}

fn build_prepared_multi(
  cores: &[String],
  prepared: &mut PreparedMode,
) -> Result<Option<MultiRegex>> {
  if cores.is_empty() {
    return Ok(None);
  }

  let fingerprint = prepared_fingerprint(cores)?;
  if let Some(loaded) = prepared.next_loaded(fingerprint, cores.len())? {
    return Ok(Some(loaded));
  }

  let refs: Vec<&str> = cores.iter().map(String::as_str).collect();
  let meta = MetaRegex::new_many(&refs)
    .map(MultiRegex::Meta)
    .map_err(|e| Error::from_reason(format!("{e}")))?;

  if !matches!(prepared, PreparedMode::Capture { .. }) {
    return Ok(Some(meta));
  }

  let artifact = match build_serializable_dense_regex(&refs) {
    Ok(dense) => PreparedMultiArtifact {
      fingerprint,
      kind: PreparedMultiKind::Dense {
        forward: serialize_dense_dfa(dense.forward()),
        reverse: serialize_dense_dfa(dense.reverse()),
      },
    },
    Err(_) => PreparedMultiArtifact {
      fingerprint,
      kind: PreparedMultiKind::Meta,
    },
  };
  prepared.push_captured(artifact);
  Ok(Some(meta))
}

fn build_serializable_dense_regex(patterns: &[&str]) -> Result<DfaRegex> {
  DfaRegex::builder()
    .dense(
      dense::Config::new()
        .dfa_size_limit(Some(PREPARED_DENSE_DFA_MAX_BYTES))
        .determinize_size_limit(Some(PREPARED_DENSE_DETERMINIZE_MAX_BYTES)),
    )
    .build_many(patterns)
    .map_err(|e| Error::from_reason(format!("{e}")))
}

fn serialize_dense_dfa(dfa: &dense::DFA<Vec<u32>>) -> Vec<u8> {
  let (bytes, pad) = dfa.to_bytes_native_endian();
  bytes[pad..].to_vec()
}

fn dense_regex_from_bytes(
  forward: &[u8],
  reverse: &[u8],
  expected_pattern_count: usize,
) -> Result<MultiRegex> {
  let forward_storage = aligned_dense_bytes(forward);
  let reverse_storage = aligned_dense_bytes(reverse);
  let forward_dfa: dense::DFA<&[u32]> =
    dense::DFA::from_bytes(aligned_dense_payload(&forward_storage))
      .map_err(|e| Error::from_reason(format!("Invalid prepared regex: {e}")))?
      .0;
  let reverse_dfa: dense::DFA<&[u32]> =
    dense::DFA::from_bytes(aligned_dense_payload(&reverse_storage))
      .map_err(|e| Error::from_reason(format!("Invalid prepared regex: {e}")))?
      .0;
  if forward_dfa.pattern_len() != expected_pattern_count
    || reverse_dfa.pattern_len() != expected_pattern_count
  {
    return Err(Error::from_reason("Prepared regex artifact mismatch"));
  }
  Ok(MultiRegex::Dense(Box::new(
    DfaRegex::builder()
      .build_from_dfas(forward_dfa.to_owned(), reverse_dfa.to_owned()),
  )))
}

fn aligned_dense_bytes(bytes: &[u8]) -> Vec<u8> {
  let mut storage: Vec<u8> = Vec::with_capacity(bytes.len() + 3);
  let base = storage.as_ptr().addr();
  let pad = (4 - (base % 4)) % 4;
  storage.resize(pad, 0);
  storage.extend_from_slice(bytes);
  storage
}

fn aligned_dense_payload(storage: &[u8]) -> &[u8] {
  let base = storage.as_ptr().addr();
  let pad = (4 - (base % 4)) % 4;
  &storage[pad..]
}

fn encode_prepared_artifacts(
  artifacts: &[PreparedMultiArtifact],
) -> Result<Vec<u8>> {
  let mut out = Vec::new();
  out.extend_from_slice(PREPARED_MAGIC);
  out.push(PREPARED_SCHEMA_VERSION);
  write_u32(
    &mut out,
    usize_to_u32("Prepared regex artifact count", artifacts.len())?,
  );
  for artifact in artifacts {
    write_u64(&mut out, artifact.fingerprint);
    match &artifact.kind {
      PreparedMultiKind::Meta => {
        out.push(PREPARED_KIND_META);
        write_u32(&mut out, 0);
        write_u32(&mut out, 0);
      }
      PreparedMultiKind::Dense { forward, reverse } => {
        out.push(PREPARED_KIND_DENSE);
        write_u32(
          &mut out,
          usize_to_u32("Prepared regex forward byte length", forward.len())?,
        );
        write_u32(
          &mut out,
          usize_to_u32("Prepared regex reverse byte length", reverse.len())?,
        );
        out.extend_from_slice(forward);
        out.extend_from_slice(reverse);
      }
    }
  }
  Ok(out)
}

fn decode_prepared_artifacts(
  bytes: &[u8],
) -> Result<Vec<PreparedMultiArtifact>> {
  let mut pos = 0;
  let magic = read_exact(bytes, &mut pos, PREPARED_MAGIC.len())?;
  if magic != PREPARED_MAGIC {
    return Err(Error::from_reason("Invalid prepared regex artifact"));
  }
  let version = read_u8(bytes, &mut pos)?;
  if version != PREPARED_SCHEMA_VERSION {
    return Err(Error::from_reason("Unsupported prepared regex artifact"));
  }
  let count = read_u32(bytes, &mut pos)?;
  let count = usize::try_from(count).map_err(|_| {
    Error::from_reason("Prepared regex artifact count is not addressable")
  })?;
  if count > PREPARED_ARTIFACT_MAX_COUNT {
    return Err(Error::from_reason(
      "Prepared regex artifact count is too large",
    ));
  }
  let mut artifacts = Vec::with_capacity(count);
  for _ in 0..count {
    let fingerprint = read_u64(bytes, &mut pos)?;
    let kind = read_u8(bytes, &mut pos)?;
    let forward_len =
      usize::try_from(read_u32(bytes, &mut pos)?).map_err(|_| {
        Error::from_reason("Prepared regex forward length is not addressable")
      })?;
    let reverse_len =
      usize::try_from(read_u32(bytes, &mut pos)?).map_err(|_| {
        Error::from_reason("Prepared regex reverse length is not addressable")
      })?;
    let kind = match kind {
      PREPARED_KIND_META => {
        if forward_len != 0 || reverse_len != 0 {
          return Err(Error::from_reason(
            "Invalid prepared regex meta artifact",
          ));
        }
        PreparedMultiKind::Meta
      }
      PREPARED_KIND_DENSE => {
        if forward_len > PREPARED_DENSE_DFA_MAX_BYTES
          || reverse_len > PREPARED_DENSE_DFA_MAX_BYTES
        {
          return Err(Error::from_reason(
            "Prepared regex artifact is too large",
          ));
        }
        let forward = read_exact(bytes, &mut pos, forward_len)?.to_vec();
        let reverse = read_exact(bytes, &mut pos, reverse_len)?.to_vec();
        PreparedMultiKind::Dense { forward, reverse }
      }
      _ => {
        return Err(Error::from_reason("Unknown prepared regex artifact kind"));
      }
    };
    artifacts.push(PreparedMultiArtifact { fingerprint, kind });
  }
  if pos != bytes.len() {
    return Err(Error::from_reason("Trailing prepared regex artifact bytes"));
  }
  Ok(artifacts)
}

fn read_exact<'a>(
  bytes: &'a [u8],
  pos: &mut usize,
  len: usize,
) -> Result<&'a [u8]> {
  let end = pos
    .checked_add(len)
    .ok_or_else(|| Error::from_reason("Prepared regex artifact overflow"))?;
  let value = bytes
    .get(*pos..end)
    .ok_or_else(|| Error::from_reason("Truncated prepared regex artifact"))?;
  *pos = end;
  Ok(value)
}

fn read_u8(bytes: &[u8], pos: &mut usize) -> Result<u8> {
  let value = read_exact(bytes, pos, 1)?;
  Ok(value[0])
}

fn read_u32(bytes: &[u8], pos: &mut usize) -> Result<u32> {
  let value = read_exact(bytes, pos, 4)?;
  Ok(u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
}

fn read_u64(bytes: &[u8], pos: &mut usize) -> Result<u64> {
  let value = read_exact(bytes, pos, 8)?;
  Ok(u64::from_le_bytes([
    value[0], value[1], value[2], value[3], value[4], value[5], value[6],
    value[7],
  ]))
}

fn write_u32(out: &mut Vec<u8>, value: u32) {
  out.extend_from_slice(&value.to_le_bytes());
}

fn write_u64(out: &mut Vec<u8>, value: u64) {
  out.extend_from_slice(&value.to_le_bytes());
}

fn prepared_fingerprint(patterns: &[String]) -> Result<u64> {
  let mut hash = PREPARED_FINGERPRINT_OFFSET;
  hash = fingerprint_byte(hash, PREPARED_SCHEMA_VERSION);
  hash = fingerprint_usize(hash, patterns.len())?;
  for pattern in patterns {
    hash = fingerprint_usize(hash, pattern.len())?;
    hash = fingerprint_bytes(hash, pattern.as_bytes());
  }
  Ok(hash)
}

fn fingerprint_usize(hash: u64, value: usize) -> Result<u64> {
  let value = u64::try_from(value)
    .map_err(|_| Error::from_reason("Prepared regex fingerprint overflow"))?;
  Ok(fingerprint_bytes(hash, &value.to_le_bytes()))
}

fn fingerprint_bytes(mut hash: u64, bytes: &[u8]) -> u64 {
  for byte in bytes {
    hash = fingerprint_byte(hash, *byte);
  }
  hash
}

fn fingerprint_byte(hash: u64, byte: u8) -> u64 {
  (hash ^ u64::from(byte)).wrapping_mul(PREPARED_FINGERPRINT_PRIME)
}

pub struct RegexSet {
  /// Fast DFA: patterns with Verifier::None
  /// and no \B boundaries.
  fast_multi: Option<MultiRegex>,
  fast_info: Vec<PatternInfo>,
  /// Slow DFA: patterns with verifiers or \B.
  /// Uses manual loop with shadowed check.
  slow_multi: Option<MultiRegex>,
  slow_info: Vec<PatternInfo>,
  /// Fancy-regex fallback patterns.
  fallbacks: Vec<FallbackPattern>,
  pattern_count: u32,
  pattern_count_usize: usize,
  has_boundaryless_pattern: bool,
  has_heterogeneous_boundaries: bool,
  unicode_wb: bool,
}

impl RegexSet {
  pub fn new(patterns: Vec<String>, options: Options) -> Result<Self> {
    let mut prepared = PreparedMode::None;
    Self::build(patterns, options, &mut prepared)
  }

  pub fn prepare(patterns: Vec<String>, options: Options) -> Result<Vec<u8>> {
    let mut prepared = PreparedMode::Capture {
      artifacts: Vec::new(),
    };
    _ = Self::build(patterns, options, &mut prepared)?;
    prepared.finish()
  }

  pub fn with_prepared(
    patterns: Vec<String>,
    options: Options,
    bytes: &[u8],
  ) -> Result<Self> {
    let mut prepared = PreparedMode::decode(bytes)?;
    let set = Self::build(patterns, options, &mut prepared)?;
    _ = prepared.finish()?;
    Ok(set)
  }

  fn build(
    patterns: Vec<String>,
    options: Options,
    prepared: &mut PreparedMode,
  ) -> Result<Self> {
    let whole_words = options.whole_words;
    let unicode_wb = options.unicode_boundaries;
    let pattern_count_usize = patterns.len();
    let pattern_count = usize_to_u32("Pattern count", pattern_count_usize)?;

    let wrapped: Vec<String> = if whole_words && !unicode_wb {
      patterns
        .iter()
        .map(|p| format!("(?-u:\\b)(?:{p})(?-u:\\b)"))
        .collect()
    } else {
      patterns
    };

    let mut fast_cores: Vec<String> = Vec::new();
    let mut fast_info: Vec<PatternInfo> = Vec::new();
    let mut slow_cores: Vec<String> = Vec::new();
    let mut slow_info: Vec<PatternInfo> = Vec::new();
    let mut fallbacks: Vec<FallbackPattern> = Vec::new();

    for (i, p) in wrapped.iter().enumerate() {
      let (stripped, mut eb) = strip_edge_boundaries(p);

      if whole_words && unicode_wb {
        eb.leading_b = true;
        eb.trailing_b = true;
        eb.leading_big_b = false;
        eb.trailing_big_b = false;
      }

      let (core, verifier) = build_verifier(&stripped).map_err(|e| {
        Error::from_reason(format!("Failed to compile pattern {i}: {e}"))
      })?;

      // Detect internal \b/\B that would cause DFA
      // state explosion in the multi-pattern DFA.
      // Replace with (?-u:\b) for the DFA core, and
      // verify matches against the individual pattern
      // (which keeps Unicode \b semantics).
      //
      // Skip the optimization if the pattern contains
      // non-ASCII characters: ASCII \b doesn't recognise
      // non-ASCII word characters, so it would miss
      // matches at Unicode word boundaries (false
      // negatives that verification can't recover).
      let internal_b = has_internal_boundary(&core) && !has_non_ascii(&core);
      let dfa_core = if internal_b {
        ascii_internal_boundaries(&core)
      } else {
        core.clone()
      };

      if let Ok(individual) = MetaRegex::new(&core) {
        // Any verifier, \B, or internal \b → slow
        // path. Only Verifier::None with no special
        // boundaries goes to fast path, because
        // find_iter can't retry rejected positions
        // for other patterns.
        let needs_slow = !matches!(&verifier, Verifier::None)
          || eb.leading_big_b
          || eb.trailing_big_b
          || internal_b;

        // Build fancy-regex fallback for patterns
        // with verifiers. When the DFA finds a greedy
        // match that the verifier rejects, fancy-regex
        // can backtrack quantifiers to find a shorter
        // valid match. This fixes cases where `\s*`
        // overshoots past a valid match and the
        // trailing lookahead fails.
        //
        // For Complex verifiers, the inner regex is
        // already compiled from the same source string,
        // so we clone it instead of recompiling.
        let fancy_fallback = match &verifier {
          Verifier::Complex(re) => Some(re.clone()),
          Verifier::Inline(_) => {
            // First convert raw \b/\B to (?-u:\b) form,
            // then expand to lookaround for fancy_regex.
            // Without this, ascii_boundary_for_fancy is a
            // no-op since stripped contains raw \b, not
            // the (?-u:\b) form it searches for.
            let fallback_source = restore_edge_boundaries(&stripped, &eb);
            let with_ascii_b = ascii_internal_boundaries(&fallback_source);
            let fancy_pat = ascii_boundary_for_fancy(&with_ascii_b);
            build_fancy_regex(&fancy_pat).ok()
          }
          Verifier::None => None,
        };

        if needs_slow {
          slow_cores.push(dfa_core);
          slow_info.push(PatternInfo {
            original_index: usize_to_u32("Pattern index", i)?,
            verifier,
            boundaries: eb,
            individual: Some(individual),
            has_internal_b: internal_b,
            fancy_fallback,
          });
        } else {
          fast_cores.push(dfa_core);
          fast_info.push(PatternInfo {
            original_index: usize_to_u32("Pattern index", i)?,
            verifier,
            boundaries: eb,
            individual: None,
            has_internal_b: false,
            // Fast path patterns never query individual or fallback state.
            fancy_fallback: None,
          });
        }
      } else {
        // Core doesn't compile in MetaRegex.
        let fallback_patterns =
          split_large_alternation(&stripped, FALLBACK_ALT_CHUNK_SIZE)
            .unwrap_or_else(|| vec![stripped.clone()]);
        for fallback_pattern in fallback_patterns {
          let fancy_pat = ascii_boundary_for_fancy(&fallback_pattern);
          let re = build_fancy_regex(&fancy_pat).map_err(|e| {
            Error::from_reason(format!("Failed to compile pattern {i}: {e}"))
          })?;
          let candidate =
            MetaRegex::new(&strip_fallback_candidate_str(&fallback_pattern))
              .ok();
          fallbacks.push(FallbackPattern {
            original_index: usize_to_u32("Pattern index", i)?,
            regex: re,
            boundaries: eb,
            candidate,
            context: fallback_pattern
              .len()
              .saturating_mul(2)
              .clamp(FALLBACK_MIN_CONTEXT, FALLBACK_MAX_CONTEXT),
          });
        }
      }
    }

    let fast_multi = build_prepared_multi(&fast_cores, prepared)?;
    let slow_multi = build_prepared_multi(&slow_cores, prepared)?;

    let all_info: Vec<&PatternInfo> =
      fast_info.iter().chain(slow_info.iter()).collect();
    let has_boundaryless_pattern =
      all_info.iter().any(|pi| !pi.boundaries.has_any());
    let has_heterogeneous_boundaries = if all_info.len() < 2 {
      false
    } else {
      let first = &all_info[0].boundaries;
      all_info.iter().any(|pi| {
        pi.boundaries.leading_b != first.leading_b
          || pi.boundaries.trailing_b != first.trailing_b
          || pi.boundaries.leading_big_b != first.leading_big_b
          || pi.boundaries.trailing_big_b != first.trailing_big_b
      })
    };

    Ok(Self {
      fast_multi,
      fast_info,
      slow_multi,
      slow_info,
      fallbacks,
      pattern_count,
      pattern_count_usize,
      has_boundaryless_pattern,
      has_heterogeneous_boundaries,
      unicode_wb,
    })
  }
  #[must_use]
  pub const fn pattern_count(&self) -> u32 {
    self.pattern_count
  }

  // ── Core match collection (single source) ──

  /// Collect all verified matches from both the
  /// multi-DFA and fallback patterns. This is the
  /// single source of truth for match logic —
  /// is_match, find_iter, which_match, and
  /// replace_all all delegate here.
  fn boundary_mode(&self, haystack: &str) -> BoundaryMode {
    let any_boundaries = self
      .fast_info
      .iter()
      .chain(self.slow_info.iter())
      .any(|pi| pi.boundaries.has_any())
      || self.fallbacks.iter().any(|fb| fb.boundaries.has_any());

    if !any_boundaries {
      return BoundaryMode::Inline { unicode: false };
    }

    // Check if unicodeBoundaries was set. We can
    // infer this from whether edge boundaries were
    // stripped (only happens with unicodeBoundaries).
    let unicode = self.unicode_wb;

    if unicode && needs_segmenter(haystack) {
      BoundaryMode::Segmenter {
        bitset: compute_uax29_boundaries(haystack),
      }
    } else {
      BoundaryMode::Inline { unicode }
    }
  }

  /// Collect all verified matches. Returns
  /// (matches, needs_sort). When only the fast DFA
  /// produced matches, they're already in order —
  /// skip the sort.
  fn collect_matches(&self, haystack: &str) -> (Vec<RawMatch>, bool) {
    let mut all: Vec<RawMatch> = Vec::new();
    let mut has_shadowed = false;
    let mode = self.boundary_mode(haystack);

    // Fast DFA: single-pass find_iter.
    // Checks boundaries + inline verifiers (None
    // or Inline char checks — never Complex).
    if let Some(ref multi) = self.fast_multi {
      multi.for_each_match(haystack, |m| {
        let pi = &self.fast_info[m.pattern().as_usize()];
        let boundary_ok = !pi.boundaries.has_any()
          || pi
            .boundaries
            .check_with_mode(haystack, m.start(), m.end(), &mode);
        if boundary_ok && pi.verifier.check(haystack, m.start(), m.end()) {
          all.push((pi.original_index, m.start(), m.end()));
        }
      });
    }

    // Slow DFA: manual loop with shadowed check.
    if let Some(ref multi) = self.slow_multi {
      let mut pos = 0;
      while pos <= haystack.len() {
        let input = Input::new(haystack).range(pos..);
        match multi.find(input) {
          Some(m) => {
            let dfa_idx = m.pattern().as_usize();
            let pi = &self.slow_info[dfa_idx];
            match check_match(haystack, m.start(), m.end(), pi, &mode) {
              Ok(()) => {
                all.push((pi.original_index, m.start(), m.end()));
                pos = m.end().max(pos + 1);
              }
              Err(ref rej) => {
                let fancy_match = if matches!(rej, Rejection::Verifier) {
                  try_verifier_fallback(pi, haystack, m.start(), m.end(), &mode)
                } else {
                  None
                };

                if let Some((fs, fe)) = fancy_match {
                  all.push((pi.original_index, fs, fe));
                  // Also check shadowed patterns:
                  // other patterns may have a valid
                  // match at the same start position.
                  // Guard is always true here (rej is
                  // Verifier), kept for symmetry with
                  // the else-if branch below.
                  let alt_end = if self.needs_shadowed_check(rej) {
                    if let Some(alt) = self.find_shadowed_slow(
                      haystack,
                      m.start(),
                      dfa_idx,
                      &mode,
                    ) {
                      let end = alt.2;
                      all.push(alt);
                      has_shadowed = true;
                      end
                    } else {
                      0
                    }
                  } else {
                    0
                  };
                  pos = fe.max(alt_end).max(pos + 1);
                } else if self.needs_shadowed_check(rej) {
                  if let Some(alt) =
                    self.find_shadowed_slow(haystack, m.start(), dfa_idx, &mode)
                  {
                    all.push(alt);
                    has_shadowed = true;
                    pos = alt.2.max(pos + 1);
                  } else {
                    pos = m.start() + 1;
                  }
                } else {
                  pos = m.start() + 1;
                }
              }
            }
          }
          None => break,
        }
      }
    }

    // Fallback patterns (fancy-regex).
    for fb in &self.fallbacks {
      let mut pos = 0;
      while pos <= haystack.len() {
        if let Some(ref candidate) = fb.candidate {
          let input = Input::new(haystack).range(pos..);
          let Some(m) = candidate.find(input) else {
            break;
          };
          if let Some(found) =
            verify_fallback_at(fb, haystack, m.start(), m.end(), &mode)
          {
            let end = found.2;
            all.push(found);
            pos = end.max(pos + 1);
          } else {
            pos = next_char_pos(haystack, m.start());
          }
          continue;
        }

        match safe_fancy_find_result(&fb.regex, haystack, pos) {
          Ok(Some((ms, me))) => {
            let passes = !fb.boundaries.has_any()
              || fb.boundaries.check_with_mode(haystack, ms, me, &mode);
            if passes {
              all.push((fb.original_index, ms, me));
              pos = me.max(pos + 1);
            } else {
              pos = ms + 1;
            }
          }
          Ok(None) => break,
          Err(()) => pos = next_char_pos(haystack, pos),
        }
      }
    }

    // Sort only needed when multiple sources
    // contributed matches. Fast DFA find_iter
    // already returns matches in position order.
    // Sort when multiple sources contributed.
    // Sort needed when matches come from multiple
    // sources (interleaved positions) or multiple
    // literal patterns (each scanned independently).
    let sources = u8::from(self.fast_multi.is_some())
      + u8::from(self.slow_multi.is_some())
      + u8::try_from(self.fallbacks.len().min(2)).unwrap_or(2);
    let needs_sort = (sources > 1 || has_shadowed) && all.len() > 1;
    (all, needs_sort)
  }

  /// Sort matches and select non-overlapping.
  fn select_non_overlapping(all: &mut [RawMatch]) -> Vec<RawMatch> {
    all.sort_by(|a, b| {
      a.1.cmp(&b.1).then_with(|| (b.2 - b.1).cmp(&(a.2 - a.1)))
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

  fn find_shadowed_slow(
    &self,
    haystack: &str,
    at: usize,
    skip: usize,
    mode: &BoundaryMode,
  ) -> Option<RawMatch> {
    for (idx, pi) in self.slow_info.iter().enumerate() {
      if idx == skip {
        continue;
      }
      let Some(individual) = &pi.individual else {
        continue;
      };
      let input = Input::new(haystack).range(at..).anchored(Anchored::Yes);
      if let Some(m) = individual.find(input) {
        if m.start() == at
          && check_match(haystack, m.start(), m.end(), pi, mode).is_ok()
        {
          return Some((pi.original_index, m.start(), m.end()));
        }
      }
    }
    None
  }

  fn needs_shadowed_check(&self, rejection: &Rejection) -> bool {
    match rejection {
      Rejection::Verifier => true,
      Rejection::Boundary => {
        self.has_boundaryless_pattern || self.has_heterogeneous_boundaries
      }
    }
  }

  // ── Internal methods ──────────────────────

  fn is_match_inner(&self, haystack: &str) -> bool {
    let mode = self.boundary_mode(haystack);

    // Fast DFA
    if let Some(ref multi) = self.fast_multi {
      let found = multi.any_match(haystack, |m| {
        let pi = &self.fast_info[m.pattern().as_usize()];
        let boundary_ok = !pi.boundaries.has_any()
          || pi
            .boundaries
            .check_with_mode(haystack, m.start(), m.end(), &mode);
        boundary_ok && pi.verifier.check(haystack, m.start(), m.end())
      });
      if found {
        return true;
      }
    }

    // Slow DFA
    if let Some(ref multi) = self.slow_multi {
      let mut pos = 0;
      while pos <= haystack.len() {
        let input = Input::new(haystack).range(pos..);
        match multi.find(input) {
          Some(m) => {
            let dfa_idx = m.pattern().as_usize();
            let pi = &self.slow_info[dfa_idx];
            match check_match(haystack, m.start(), m.end(), pi, &mode) {
              Ok(()) => return true,
              Err(ref rej) => {
                if matches!(rej, Rejection::Verifier)
                  && try_verifier_fallback(
                    pi,
                    haystack,
                    m.start(),
                    m.end(),
                    &mode,
                  )
                  .is_some()
                {
                  return true;
                }
                if self.needs_shadowed_check(rej)
                  && self
                    .find_shadowed_slow(haystack, m.start(), dfa_idx, &mode)
                    .is_some()
                {
                  return true;
                }
              }
            }
            pos = m.start() + 1;
          }
          None => break,
        }
      }
    }

    for fb in &self.fallbacks {
      let mut pos = 0;
      while pos <= haystack.len() {
        if let Some(ref candidate) = fb.candidate {
          let input = Input::new(haystack).range(pos..);
          let Some(m) = candidate.find(input) else {
            break;
          };
          if verify_fallback_at(fb, haystack, m.start(), m.end(), &mode)
            .is_some()
          {
            return true;
          }
          pos = next_char_pos(haystack, m.start());
          continue;
        }

        match safe_fancy_find_result(&fb.regex, haystack, pos) {
          Ok(Some((ms, me))) => {
            let passes = !fb.boundaries.has_any()
              || fb.boundaries.check_with_mode(haystack, ms, me, &mode);
            if passes {
              return true;
            }
            pos = ms + 1;
          }
          Ok(None) => break,
          Err(()) => pos = next_char_pos(haystack, pos),
        }
      }
    }
    false
  }

  fn find_iter_packed_inner(&self, haystack: &str) -> Result<Vec<u32>> {
    let (mut all, needs_sort) = self.collect_matches(haystack);

    if all.is_empty() {
      return Ok(Vec::new());
    }

    let selected = if needs_sort {
      Self::select_non_overlapping(&mut all)
    } else {
      all
    };

    // Pack with UTF-16 offsets.
    if haystack.is_ascii() {
      let mut packed = Vec::with_capacity(selected.len() * 3);
      for (pat, start, end) in selected {
        packed.push(pat);
        packed.push(usize_to_u32("Match start offset", start)?);
        packed.push(usize_to_u32("Match end offset", end)?);
      }
      return Ok(packed);
    }

    let bytes = haystack.as_bytes();
    let mut packed = Vec::with_capacity(selected.len() * 3);
    let mut last_byte: usize = 0;
    let mut last_utf16: u32 = 0;

    for (pat, start, end) in selected {
      last_utf16 = last_utf16
        .checked_add(byte_span_utf16_len(&bytes[last_byte..start])?)
        .ok_or_else(|| {
          Error::from_reason("UTF-16 start offset exceeds u32 range")
        })?;
      let utf16_start = last_utf16;
      last_byte = start;

      last_utf16 = last_utf16
        .checked_add(byte_span_utf16_len(&bytes[last_byte..end])?)
        .ok_or_else(|| {
          Error::from_reason("UTF-16 end offset exceeds u32 range")
        })?;
      let utf16_end = last_utf16;
      last_byte = end;

      packed.push(pat);
      packed.push(utf16_start);
      packed.push(utf16_end);
    }
    Ok(packed)
  }

  /// Byte-offset counterpart of [`find_iter_packed_inner`].
  ///
  /// Emits raw UTF-8 byte offsets instead of UTF-16 code-unit
  /// offsets, so no UTF-16 translation is needed.
  fn find_iter_packed_bytes_inner(&self, haystack: &str) -> Result<Vec<u32>> {
    let (mut all, needs_sort) = self.collect_matches(haystack);

    if all.is_empty() {
      return Ok(Vec::new());
    }

    let selected = if needs_sort {
      Self::select_non_overlapping(&mut all)
    } else {
      all
    };

    // Pack with raw UTF-8 byte offsets.
    let mut packed = Vec::with_capacity(selected.len() * 3);
    for (pat, start, end) in selected {
      packed.push(pat);
      packed.push(usize_to_u32("Match start offset", start)?);
      packed.push(usize_to_u32("Match end offset", end)?);
    }
    Ok(packed)
  }

  #[must_use]
  pub fn is_match(&self, haystack: &str) -> bool {
    self.is_match_inner(haystack)
  }

  pub fn is_match_buf(&self, haystack: &[u8]) -> Result<bool> {
    let text = std::str::from_utf8(haystack)
      .map_err(|e| Error::from_reason(format!("Invalid UTF-8: {e}")))?;
    Ok(self.is_match_inner(text))
  }

  pub fn find_iter_packed(&self, haystack: &str) -> Result<Vec<u32>> {
    self.find_iter_packed_inner(haystack)
  }

  pub fn find_iter_packed_buf(&self, haystack: &[u8]) -> Result<Vec<u32>> {
    let text = std::str::from_utf8(haystack)
      .map_err(|e| Error::from_reason(format!("Invalid UTF-8: {e}")))?;
    self.find_iter_packed_inner(text)
  }

  /// Byte-offset counterpart of [`RegexSet::find_iter_packed`].
  ///
  /// Same packed layout `[pattern, start, end, ...]`, but offsets
  /// are raw UTF-8 byte offsets rather than UTF-16 code units.
  /// Intended for native Rust consumers that slice `&str` directly.
  pub fn find_iter_packed_bytes(&self, haystack: &str) -> Result<Vec<u32>> {
    self.find_iter_packed_bytes_inner(haystack)
  }

  /// Byte-offset counterpart of [`RegexSet::find_iter_packed_buf`].
  pub fn find_iter_packed_bytes_buf(
    &self,
    haystack: &[u8],
  ) -> Result<Vec<u32>> {
    let text = std::str::from_utf8(haystack)
      .map_err(|e| Error::from_reason(format!("Invalid UTF-8: {e}")))?;
    self.find_iter_packed_bytes_inner(text)
  }

  #[must_use]
  pub fn which_match(&self, haystack: &str) -> Vec<u32> {
    let (all, _) = self.collect_matches(haystack);
    let mut seen = vec![false; self.pattern_count_usize];
    let mut result = Vec::new();
    for (pat, _, _) in all {
      let Ok(idx) = pattern_index_to_usize(pat) else {
        continue;
      };
      let Some(is_seen) = seen.get_mut(idx) else {
        continue;
      };
      if !*is_seen {
        *is_seen = true;
        result.push(pat);
      }
    }
    result
  }
  pub fn replace_all(
    &self,
    haystack: &str,
    replacements: &[String],
  ) -> Result<String> {
    if replacements.len() != self.pattern_count_usize {
      return Err(Error::from_reason(format!(
        "Expected {} replacements, got {}",
        self.pattern_count,
        replacements.len()
      )));
    }

    let (mut all, needs_sort) = self.collect_matches(haystack);
    let selected = if needs_sort {
      Self::select_non_overlapping(&mut all)
    } else {
      all
    };

    let mut result = String::with_capacity(haystack.len());
    let mut last: usize = 0;

    for (pat, start, end) in selected {
      result.push_str(&haystack[last..start]);
      let replacement = replacements
        .get(pattern_index_to_usize(pat)?)
        .ok_or_else(|| {
          Error::from_reason(format!("Invalid pattern index: {pat}"))
        })?;
      result.push_str(replacement);
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
pub fn uax29_boundaries(haystack: &[u8]) -> Result<Vec<u32>> {
  let text = std::str::from_utf8(haystack)
    .map_err(|e| Error::from_reason(format!("Invalid UTF-8: {e}")))?;

  let mut boundaries = Vec::new();
  for word in text.unicode_word_indices() {
    boundaries.push(usize_to_u32("UAX29 boundary", word.0)?);
    let end = word
      .0
      .checked_add(word.1.len())
      .ok_or_else(|| Error::from_reason("UAX29 boundary overflow"))?;
    boundaries.push(usize_to_u32("UAX29 boundary", end)?);
  }
  // Add 0 and len as boundaries
  if boundaries.first().is_none_or(|first| *first != 0) {
    boundaries.insert(0, 0);
  }
  let len = usize_to_u32("UAX29 text length", text.len())?;
  if *boundaries.last().unwrap_or(&0) != len {
    boundaries.push(len);
  }
  boundaries.sort_unstable();
  boundaries.dedup();
  Ok(boundaries)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn split_large_alternation_skips_negative_lookaround_groups() {
    let alts = (0..140)
      .map(|i| format!("BAD{i}"))
      .collect::<Vec<_>>()
      .join("|");
    let pattern = format!(r"foo(?!(?:{alts}))\w+");

    assert!(split_large_alternation(&pattern, 128).is_none());
  }

  #[test]
  fn split_large_alternation_keeps_negative_assertion_intact() {
    let alts = (0..140)
      .map(|i| format!("GOOD{i}"))
      .collect::<Vec<_>>()
      .join("|");
    let pattern = format!(r"(?:{alts})(?!BAD)");

    let chunks = split_large_alternation(&pattern, 128);
    assert!(chunks.is_some(), "outer alternation should split");
    let Some(chunks) = chunks else {
      return;
    };
    assert_eq!(chunks.len(), 2);
    assert!(chunks.iter().all(|chunk| chunk.ends_with("(?!BAD)")));
  }

  #[test]
  fn find_matching_paren_ignores_class_parens() {
    let pattern = r"foo(?=\s|[.,;!?)]|$)bar";
    let start = pattern.find("(?=");
    assert!(start.is_some(), "fixture must contain lookahead");
    let Some(start) = start else {
      return;
    };
    let end = find_matching_paren(pattern, start);
    assert!(end.is_some(), "lookahead should have a matching paren");
    let Some(end) = end else {
      return;
    };

    assert_eq!(&pattern[end..], ")bar");
  }

  #[test]
  fn fallback_candidate_strips_full_lookahead() {
    let pattern = r"foo(?=\s|[.,;!?)]|$)bar";

    assert_eq!(strip_fallback_candidate_str(pattern), "foobar");
  }

  #[test]
  fn packed_byte_offsets_diverge_from_utf16() -> Result<()> {
    // `ä` is 2 UTF-8 bytes but 1 UTF-16 code unit, so byte and
    // UTF-16 offsets for the trailing `b` diverge.
    let set = RegexSet::new(vec!["b".to_owned()], Options::default())?;
    let haystack = "äb";

    // Existing UTF-16 method: `b` is at UTF-16 offsets 1..2.
    assert_eq!(
      set.find_iter_packed(haystack)?,
      vec![0, 1, 2],
      "expected UTF-16 offsets"
    );

    // New byte-offset variant: `b` is at byte offsets 2..3.
    assert_eq!(
      set.find_iter_packed_bytes(haystack)?,
      vec![0, 2, 3],
      "expected raw UTF-8 byte offsets"
    );
    Ok(())
  }

  #[test]
  fn prepared_regex_set_matches_unprepared() -> Result<()> {
    let patterns = vec![
      String::from(r"\bfoo\b"),
      String::from(r"\d{2}\.\d{2}\.\d{4}"),
      String::from(r"(?i-u:bar)"),
      String::from(r"X\d+(?!\d)"),
    ];
    let options = Options::default();
    let haystack = "foo 15.03.1990 BAR X123 čfoo";
    let replacements = vec![
      String::from("[WORD]"),
      String::from("[DATE]"),
      String::from("[BAR]"),
      String::from("[CODE]"),
    ];

    let artifact = RegexSet::prepare(patterns.clone(), options)?;
    let baseline = RegexSet::new(patterns.clone(), options)?;
    let prepared = RegexSet::with_prepared(patterns, options, &artifact)?;

    assert_eq!(
      baseline.find_iter_packed(haystack)?,
      prepared.find_iter_packed(haystack)?
    );
    assert_eq!(baseline.is_match(haystack), prepared.is_match(haystack));
    assert_eq!(
      baseline.which_match(haystack),
      prepared.which_match(haystack)
    );
    assert_eq!(
      baseline.replace_all(haystack, &replacements)?,
      prepared.replace_all(haystack, &replacements)?
    );
    Ok(())
  }

  #[test]
  fn prepared_regex_set_rejects_mismatched_patterns() -> Result<()> {
    let options = Options::default();
    let artifact = RegexSet::prepare(vec![String::from("foo")], options)?;
    let result =
      RegexSet::with_prepared(vec![String::from("bar")], options, &artifact);

    assert!(result.is_err(), "artifact must match prepared patterns");
    Ok(())
  }

  #[test]
  fn prepared_regex_set_rejects_mismatched_dense_pattern_count() -> Result<()> {
    let options = Options::default();
    let source = RegexSet::prepare(vec![String::from("foo")], options)?;
    let [PreparedMultiArtifact { kind, .. }] =
      decode_prepared_artifacts(&source)?
        .try_into()
        .map_err(|_| {
          Error::from_reason("expected a single prepared regex artifact")
        })?;
    assert!(
      matches!(&kind, PreparedMultiKind::Dense { .. }),
      "simple patterns should produce dense artifacts"
    );

    let patterns = vec![String::from("foo"), String::from("bar")];
    let artifact = encode_prepared_artifacts(&[PreparedMultiArtifact {
      fingerprint: prepared_fingerprint(&patterns)?,
      kind,
    }])?;
    let result = RegexSet::with_prepared(patterns, options, &artifact);

    assert!(
      result.is_err(),
      "dense artifacts must declare the expected pattern count"
    );
    Ok(())
  }

  #[test]
  fn prepared_regex_set_rejects_oversized_artifact_count() {
    let mut artifact = Vec::new();
    artifact.extend_from_slice(PREPARED_MAGIC);
    artifact.push(PREPARED_SCHEMA_VERSION);
    write_u32(&mut artifact, 3);

    let result = RegexSet::with_prepared(
      vec![String::from("foo")],
      Options::default(),
      &artifact,
    );

    assert!(result.is_err(), "artifact count must be bounded");
  }

  #[test]
  fn prepared_regex_set_rejects_meta_payload_lengths() {
    let mut artifact = Vec::new();
    artifact.extend_from_slice(PREPARED_MAGIC);
    artifact.push(PREPARED_SCHEMA_VERSION);
    write_u32(&mut artifact, 1);
    write_u64(&mut artifact, 0);
    artifact.push(PREPARED_KIND_META);
    write_u32(&mut artifact, 1);
    write_u32(&mut artifact, 0);

    let result = RegexSet::with_prepared(
      vec![String::from("foo")],
      Options::default(),
      &artifact,
    );

    assert!(
      result.is_err(),
      "meta artifacts must not declare payload bytes"
    );
  }

  #[test]
  fn prepared_regex_set_skips_oversized_dense_artifacts() -> Result<()> {
    let options = Options::default();
    let patterns = vec![String::from(r"\w{20}")];
    let artifact = RegexSet::prepare(patterns.clone(), options)?;

    assert!(
      artifact.len() < 1024,
      "oversized dense DFAs should fall back to compact prepared markers"
    );

    let baseline = RegexSet::new(patterns.clone(), options)?;
    let prepared = RegexSet::with_prepared(patterns, options, &artifact)?;
    assert_eq!(
      baseline.find_iter_packed("abcdefghijklmnopqrst")?,
      prepared.find_iter_packed("abcdefghijklmnopqrst")?
    );
    Ok(())
  }
}
