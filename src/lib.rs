use napi::bindgen_prelude::{Buffer, Error, Result, Uint32Array};
use napi_derive::napi;
use stella_regex_set_core as core;

fn core_to_napi_error(error: &core::Error) -> Error {
  Error::from_reason(error.to_string())
}

#[napi(object)]
pub struct Options {
  pub whole_words: Option<bool>,
  pub unicode_boundaries: Option<bool>,
}

#[napi(object)]
pub struct Match {
  pub pattern: u32,
  pub start: u32,
  pub end: u32,
}

fn resolve_options(options: Option<Options>) -> core::Options {
  let opts = options.unwrap_or(Options {
    whole_words: None,
    unicode_boundaries: None,
  });
  core::Options {
    whole_words: opts.whole_words.unwrap_or(false),
    unicode_boundaries: opts.unicode_boundaries.unwrap_or(true),
  }
}

#[napi]
pub struct RegexSet {
  inner: core::RegexSet,
}

#[napi]
impl RegexSet {
  #[napi(constructor)]
  #[allow(clippy::needless_pass_by_value)]
  pub fn new(patterns: Vec<String>, options: Option<Options>) -> Result<Self> {
    let inner = core::RegexSet::new(patterns, resolve_options(options))
      .map_err(|error| core_to_napi_error(&error))?;
    Ok(Self { inner })
  }

  #[napi(getter)]
  #[must_use]
  pub const fn pattern_count(&self) -> u32 {
    self.inner.pattern_count()
  }

  #[napi]
  #[must_use]
  #[allow(clippy::needless_pass_by_value)]
  pub fn is_match(&self, haystack: String) -> bool {
    self.inner.is_match(&haystack)
  }

  #[napi(js_name = "_isMatchBuf")]
  #[allow(clippy::needless_pass_by_value)]
  pub fn is_match_buf(&self, haystack: Buffer) -> Result<bool> {
    self
      .inner
      .is_match_buf(haystack.as_ref())
      .map_err(|error| core_to_napi_error(&error))
  }

  #[napi(js_name = "_findIterPacked")]
  #[allow(clippy::needless_pass_by_value)]
  pub fn find_iter_packed(&self, haystack: String) -> Result<Uint32Array> {
    self
      .inner
      .find_iter_packed(&haystack)
      .map(Uint32Array::new)
      .map_err(|error| core_to_napi_error(&error))
  }

  #[napi(js_name = "_findIterPackedBuf")]
  #[allow(clippy::needless_pass_by_value)]
  pub fn find_iter_packed_buf(&self, haystack: Buffer) -> Result<Uint32Array> {
    self
      .inner
      .find_iter_packed_buf(haystack.as_ref())
      .map(Uint32Array::new)
      .map_err(|error| core_to_napi_error(&error))
  }

  #[napi]
  #[must_use]
  #[allow(clippy::needless_pass_by_value)]
  pub fn which_match(&self, haystack: String) -> Vec<u32> {
    self.inner.which_match(&haystack)
  }

  #[napi]
  #[allow(clippy::needless_pass_by_value)]
  pub fn replace_all(
    &self,
    haystack: String,
    replacements: Vec<String>,
  ) -> Result<String> {
    self
      .inner
      .replace_all(&haystack, &replacements)
      .map_err(|error| core_to_napi_error(&error))
  }
}

#[napi(js_name = "_uax29Boundaries")]
#[allow(clippy::needless_pass_by_value)]
pub fn uax29_boundaries(haystack: Buffer) -> Result<Vec<u32>> {
  core::uax29_boundaries(haystack.as_ref())
    .map_err(|error| core_to_napi_error(&error))
}
