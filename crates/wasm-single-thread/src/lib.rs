use serde::{Deserialize, Serialize};
use std::{cell::RefCell, collections::HashMap};
use stella_regex_set_core::{Options, RegexSet, uax29_boundaries};

thread_local! {
  static STATE: RefCell<State> = RefCell::new(State::default());
}

#[derive(Default)]
struct State {
  next: u32,
  sets: HashMap<u32, RegexSet>,
  output: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Request {
  Create {
    patterns: Vec<String>,
    whole_words: bool,
    unicode_boundaries: bool,
    prepared: Option<Vec<u8>>,
  },
  Prepare {
    patterns: Vec<String>,
    whole_words: bool,
    unicode_boundaries: bool,
  },
  Free {
    handle: u32,
  },
  Counts {
    handle: u32,
  },
  IsMatch {
    handle: u32,
    haystack: String,
  },
  IsMatchBuf {
    handle: u32,
    haystack: Vec<u8>,
  },
  Find {
    handle: u32,
    haystack: String,
  },
  FindBuf {
    handle: u32,
    haystack: Vec<u8>,
  },
  Which {
    handle: u32,
    haystack: String,
  },
  Replace {
    handle: u32,
    haystack: String,
    replacements: Vec<String>,
  },
  Boundaries {
    haystack: Vec<u8>,
  },
}

#[derive(Serialize)]
struct Response<T: Serialize> {
  ok: bool,
  value: Option<T>,
  error: Option<String>,
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc(length: usize) -> *mut u8 {
  let mut bytes = Vec::<u8>::with_capacity(length);
  let pointer = bytes.as_mut_ptr();
  std::mem::forget(bytes);
  pointer
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn dispatch(pointer: *mut u8, length: usize) {
  let input = unsafe { Vec::from_raw_parts(pointer, length, length) };
  let result = run(&input);
  STATE.with_borrow_mut(|state| state.output = result);
}

#[unsafe(no_mangle)]
pub extern "C" fn output_pointer() -> *const u8 {
  STATE.with_borrow(|state| state.output.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn output_length() -> usize {
  STATE.with_borrow(|state| state.output.len())
}

fn options(whole_words: bool, unicode_boundaries: bool) -> Options {
  Options::builder()
    .whole_words(whole_words)
    .unicode_boundaries(unicode_boundaries)
    .build()
}

fn run(input: &[u8]) -> Vec<u8> {
  let result = serde_json::from_slice(input)
    .map_err(|error| error.to_string())
    .and_then(execute);
  serde_json::to_vec(&match result {
    Ok(value) => Response {
      ok: true,
      value: Some(value),
      error: None,
    },
    Err(error) => Response {
      ok: false,
      value: None,
      error: Some(error),
    },
  })
  .expect("serializing a JSON response cannot fail")
}

fn execute(request: Request) -> Result<serde_json::Value, String> {
  STATE.with_borrow_mut(|state| {
    let value = match request {
      Request::Create {
        patterns,
        whole_words,
        unicode_boundaries,
        prepared,
      } => {
        let opts = options(whole_words, unicode_boundaries);
        let set = match prepared {
          Some(bytes) => RegexSet::with_prepared(patterns, opts, &bytes),
          None => RegexSet::new(patterns, opts),
        }
        .map_err(|e| e.to_string())?;
        state.next = state
          .next
          .checked_add(1)
          .ok_or("WASM matcher handle overflow")?;
        let handle = state.next;
        state.sets.insert(handle, set);
        serde_json::json!(handle)
      }
      Request::Prepare {
        patterns,
        whole_words,
        unicode_boundaries,
      } => serde_json::json!(
        RegexSet::prepare(patterns, options(whole_words, unicode_boundaries))
          .map_err(|e| e.to_string())?
      ),
      Request::Free { handle } => {
        state.sets.remove(&handle);
        serde_json::Value::Null
      }
      Request::Boundaries { haystack } => serde_json::json!(
        uax29_boundaries(&haystack).map_err(|e| e.to_string())?
      ),
      request => {
        let handle = match &request {
          Request::Counts { handle }
          | Request::IsMatch { handle, .. }
          | Request::IsMatchBuf { handle, .. }
          | Request::Find { handle, .. }
          | Request::FindBuf { handle, .. }
          | Request::Which { handle, .. }
          | Request::Replace { handle, .. } => *handle,
          _ => unreachable!(),
        };
        let set = state
          .sets
          .get(&handle)
          .ok_or("Unknown WASM matcher handle")?;
        match request {
          Request::Counts { .. } => serde_json::json!(set.engine_path_counts()),
          Request::IsMatch { haystack, .. } => {
            serde_json::json!(set.is_match(&haystack))
          }
          Request::IsMatchBuf { haystack, .. } => serde_json::json!(
            set.is_match_buf(&haystack).map_err(|e| e.to_string())?
          ),
          Request::Find { haystack, .. } => serde_json::json!(
            set.find_iter_packed(&haystack).map_err(|e| e.to_string())?
          ),
          Request::FindBuf { haystack, .. } => serde_json::json!(
            set
              .find_iter_packed_buf(&haystack)
              .map_err(|e| e.to_string())?
          ),
          Request::Which { haystack, .. } => {
            serde_json::json!(set.which_match(&haystack))
          }
          Request::Replace {
            haystack,
            replacements,
            ..
          } => serde_json::json!(
            set
              .replace_all(&haystack, &replacements)
              .map_err(|e| e.to_string())?
          ),
          _ => unreachable!(),
        }
      }
    };
    Ok(value)
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn rejects_malformed_requests() {
    let response: serde_json::Value =
      serde_json::from_slice(&run(b"nope")).unwrap();
    assert_eq!(response["ok"], false);
  }
}
