use std::{cell::RefCell, collections::HashMap};

use serde_json::{Value, json};
use stella_regex_set_core::{Options, RegexSet, uax29_boundaries};

#[derive(Default)]
struct State {
  input: Vec<u8>,
  output: Vec<u8>,
  handles: HashMap<u32, RegexSet>,
  next_id: u32,
}

thread_local! {
  static STATE: RefCell<State> = RefCell::new(State::default());
}

type Result<T> = std::result::Result<T, String>;

fn string_field<'a>(command: &'a Value, name: &str) -> Result<&'a str> {
  command
    .get(name)
    .and_then(Value::as_str)
    .ok_or_else(|| format!("{name} must be a string"))
}

fn strings_field(command: &Value, name: &str) -> Result<Vec<String>> {
  command
    .get(name)
    .and_then(Value::as_array)
    .ok_or_else(|| format!("{name} must be an array"))?
    .iter()
    .map(|value| {
      value
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("{name} must contain strings"))
    })
    .collect()
}

fn bytes_field(command: &Value) -> Result<Vec<u8>> {
  command
    .get("bytes")
    .and_then(Value::as_array)
    .ok_or_else(|| "bytes must be an array".to_owned())?
    .iter()
    .map(|value| {
      value
        .as_u64()
        .and_then(|n| u8::try_from(n).ok())
        .ok_or_else(|| "bytes must contain integers from 0 to 255".to_owned())
    })
    .collect()
}

fn id_field(command: &Value) -> Result<u32> {
  command
    .get("id")
    .and_then(Value::as_u64)
    .and_then(|id| u32::try_from(id).ok())
    .ok_or_else(|| "id must be a u32".to_owned())
}

fn bool_option(options: &Value, name: &str, default: bool) -> Result<bool> {
  options.get(name).map_or(Ok(default), |value| {
    value
      .as_bool()
      .ok_or_else(|| format!("{name} must be a boolean"))
  })
}

fn options_field(command: &Value) -> Result<Options> {
  let Some(options) = command.get("options") else {
    return Ok(Options::default());
  };
  if !options.is_object() {
    return Err("options must be an object".to_owned());
  }
  Ok(Options {
    whole_words: bool_option(options, "wholeWords", false)?,
    unicode_boundaries: bool_option(options, "unicodeBoundaries", true)?,
  })
}

impl State {
  fn insert(&mut self, matcher: RegexSet) -> Result<Value> {
    let id = self
      .next_id
      .checked_add(1)
      .ok_or_else(|| "handle ids exhausted".to_owned())?;
    self.next_id = id;
    self.handles.insert(id, matcher);
    Ok(json!(id))
  }

  fn matcher(&self, command: &Value) -> Result<&RegexSet> {
    self
      .handles
      .get(&id_field(command)?)
      .ok_or_else(|| "unknown matcher id".to_owned())
  }

  fn execute(&mut self, command: &Value) -> Result<Value> {
    match string_field(command, "op")? {
      "new" => {
        let matcher = RegexSet::new(
          strings_field(command, "patterns")?,
          options_field(command)?,
        )
        .map_err(|error| error.to_string())?;
        self.insert(matcher)
      }
      "prepare" => RegexSet::prepare(
        strings_field(command, "patterns")?,
        options_field(command)?,
      )
      .map(|bytes| json!(bytes))
      .map_err(|error| error.to_string()),
      "fromPrepared" => {
        let matcher = RegexSet::with_prepared(
          strings_field(command, "patterns")?,
          options_field(command)?,
          &bytes_field(command)?,
        )
        .map_err(|error| error.to_string())?;
        self.insert(matcher)
      }
      "patternCount" => Ok(json!(self.matcher(command)?.pattern_count())),
      "isMatch" => Ok(json!(
        self
          .matcher(command)?
          .is_match(string_field(command, "haystack")?)
      )),
      "findIter" => self
        .matcher(command)?
        .find_iter_packed(string_field(command, "haystack")?)
        .map(|value| json!(value))
        .map_err(|error| error.to_string()),
      "replaceAll" => self
        .matcher(command)?
        .replace_all(
          string_field(command, "haystack")?,
          &strings_field(command, "replacements")?,
        )
        .map(|value| json!(value))
        .map_err(|error| error.to_string()),
      "findIterBuf" => self
        .matcher(command)?
        .find_iter_packed_buf(&bytes_field(command)?)
        .map(|value| json!(value))
        .map_err(|error| error.to_string()),
      "isMatchBuf" => self
        .matcher(command)?
        .is_match_buf(&bytes_field(command)?)
        .map(|value| json!(value))
        .map_err(|error| error.to_string()),
      "whichMatch" => Ok(json!(
        self
          .matcher(command)?
          .which_match(string_field(command, "haystack")?)
      )),
      "uax29Boundaries" => uax29_boundaries(&bytes_field(command)?)
        .map(|value| json!(value))
        .map_err(|error| error.to_string()),
      "free" => {
        self
          .handles
          .remove(&id_field(command)?)
          .ok_or_else(|| "unknown matcher id".to_owned())?;
        Ok(Value::Null)
      }
      _ => Err("unknown operation".to_owned()),
    }
  }
}

/// Allocate initialized input bytes; the returned offset remains valid until the next allocation.
// Exporting a named ABI symbol requires an unsafe attribute in Rust 2024; no unsafe operations occur.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn regex_input_alloc(len: u32) -> u32 {
  STATE.with_borrow_mut(|state| {
    let Ok(len) = usize::try_from(len) else {
      return 0;
    };
    state.input.resize(len, 0);
    u32::try_from(state.input.as_ptr().addr()).unwrap_or(0)
  })
}

/// Execute the input JSON command. Status is zero on success and one on an error.
// Only the export attribute is unsafe; command processing uses initialized owned buffers.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn regex_run() -> u32 {
  STATE.with_borrow_mut(|state| {
    let result = serde_json::from_slice::<Value>(&state.input)
      .map_err(|error| error.to_string())
      .and_then(|command| state.execute(&command));
    let (status, response) = match result {
      Ok(value) => (0, json!({"value": value})),
      Err(error) => (1, json!({"error": error})),
    };
    state.output = response.to_string().into_bytes();
    status
  })
}

/// Return the output offset, valid until the next command executes.
// Only the symbol export uses an unsafe attribute; obtaining a pointer is safe.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn regex_output_ptr() -> u32 {
  STATE.with_borrow(|state| {
    u32::try_from(state.output.as_ptr().addr()).unwrap_or(0)
  })
}

/// Return the number of initialized output bytes.
// Only the symbol export uses an unsafe attribute.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn regex_output_len() -> u32 {
  STATE
    .with_borrow(|state| u32::try_from(state.output.len()).unwrap_or(u32::MAX))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::missing_assert_message)]
mod tests {
  use super::{State, json};

  #[test]
  fn prepared_handles_preserve_unicode_matching_and_ownership() {
    let mut state = State::default();
    let patterns = json!(["é", "😀"]);
    let options = json!({"wholeWords": false, "unicodeBoundaries": true});
    let id = state
      .execute(&json!({"op": "new", "patterns": patterns, "options": options}))
      .unwrap();
    let bytes = state
      .execute(
        &json!({"op": "prepare", "patterns": patterns, "options": options}),
      )
      .unwrap();
    let restored = state.execute(&json!({"op": "fromPrepared", "patterns": patterns, "options": options, "bytes": bytes})).unwrap();
    for handle in [&id, &restored] {
      assert_eq!(
        state
          .execute(&json!({"op": "patternCount", "id": handle}))
          .unwrap(),
        json!(2)
      );
      assert_eq!(
        state
          .execute(&json!({"op": "isMatch", "id": handle, "haystack": "é😀"}))
          .unwrap(),
        json!(true)
      );
      assert_eq!(
        state
          .execute(&json!({"op": "findIter", "id": handle, "haystack": "é😀"}))
          .unwrap(),
        json!([0, 0, 1, 1, 1, 3])
      );
      assert_eq!(state.execute(&json!({"op": "findIterBuf", "id": handle, "bytes": [195, 169, 240, 159, 152, 128]})).unwrap(), json!([0, 0, 1, 1, 1, 3]));
      assert_eq!(
        state
          .execute(
            &json!({"op": "isMatchBuf", "id": handle, "bytes": [195, 169]})
          )
          .unwrap(),
        json!(true)
      );
      assert_eq!(
        state
          .execute(
            &json!({"op": "whichMatch", "id": handle, "haystack": "é😀"})
          )
          .unwrap(),
        json!([0, 1])
      );
      assert_eq!(state.execute(&json!({"op": "replaceAll", "id": handle, "haystack": "é😀", "replacements": ["a", "b"]})).unwrap(), json!("ab"));
    }
    assert_eq!(
      state
        .execute(&json!({"op": "uax29Boundaries", "bytes": [195, 169]}))
        .unwrap(),
      json!([0, 2])
    );
    state.execute(&json!({"op": "free", "id": id})).unwrap();
    assert!(
      state
        .execute(&json!({"op": "patternCount", "id": id}))
        .is_err()
    );
    assert_eq!(
      state
        .execute(&json!({"op": "patternCount", "id": restored}))
        .unwrap(),
      json!(2)
    );
  }

  #[test]
  fn validates_protocol_and_utf8_buffer_inputs() {
    let mut state = State::default();
    for command in [
      json!({"op": "new", "patterns": [null]}),
      json!({"op": "new", "patterns": [], "options": {"wholeWords": 1}}),
      json!({"op": "new", "patterns": [], "options": {"unicodeBoundaries": "true"}}),
      json!({"op": "fromPrepared", "patterns": [], "bytes": [256]}),
      json!({"op": "free", "id": -1}),
      json!({"op": "unknown"}),
    ] {
      assert!(state.execute(&command).is_err());
    }
    let id = state
      .execute(&json!({"op": "new", "patterns": ["é"]}))
      .unwrap();
    for op in ["findIterBuf", "isMatchBuf"] {
      assert!(
        state
          .execute(&json!({"op": op, "id": id, "bytes": [255]}))
          .is_err()
      );
    }
    assert!(
      state
        .execute(&json!({"op": "uax29Boundaries", "bytes": [255]}))
        .is_err()
    );
  }
}
