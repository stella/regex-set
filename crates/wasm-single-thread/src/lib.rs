use std::{cell::RefCell, collections::HashMap, mem};

use stella_regex_set_core::{Options, RegexSet, uax29_boundaries};

type Result<T> = std::result::Result<T, String>;
const U32_BYTES: usize = 4;
const FLAG_WHOLE_WORDS: u32 = 8;
const FLAG_ASCII_BOUNDARIES: u32 = 16;
const KNOWN_FLAGS: u32 = FLAG_WHOLE_WORDS | FLAG_ASCII_BOUNDARIES;

#[derive(Clone, Copy)]
enum Operation {
  New,
  Prepare,
  FromPrepared,
  PatternCount,
  IsMatch,
  FindIter,
  ReplaceAll,
  FindIterBuf,
  IsMatchBuf,
  WhichMatch,
  Uax29Boundaries,
  Free,
}

impl TryFrom<u32> for Operation {
  type Error = String;
  fn try_from(value: u32) -> Result<Self> {
    match value {
      1 => Ok(Self::New),
      2 => Ok(Self::Prepare),
      3 => Ok(Self::FromPrepared),
      4 => Ok(Self::PatternCount),
      5 => Ok(Self::IsMatch),
      6 => Ok(Self::FindIter),
      8 => Ok(Self::ReplaceAll),
      9 => Ok(Self::FindIterBuf),
      10 => Ok(Self::IsMatchBuf),
      16 => Ok(Self::Free),
      17 => Ok(Self::WhichMatch),
      18 => Ok(Self::Uax29Boundaries),
      _ => Err("unknown operation".to_owned()),
    }
  }
}

struct Reader<'a> {
  remaining: &'a [u8],
}

impl<'a> Reader<'a> {
  fn take(&mut self, len: usize) -> Result<&'a [u8]> {
    let (value, rest) = self
      .remaining
      .split_at_checked(len)
      .ok_or_else(|| "truncated request".to_owned())?;
    self.remaining = rest;
    Ok(value)
  }

  fn u32(&mut self) -> Result<u32> {
    let bytes = self
      .take(U32_BYTES)?
      .try_into()
      .map_err(|_| "invalid u32".to_owned())?;
    Ok(u32::from_le_bytes(bytes))
  }
}

struct Request<'a> {
  operation: Operation,
  id: u32,
  options: Options,
  strings: Vec<&'a str>,
  payload: &'a [u8],
}

impl<'a> Request<'a> {
  fn parse(input: &'a [u8]) -> Result<Self> {
    let mut reader = Reader { remaining: input };
    let operation = Operation::try_from(reader.u32()?)?;
    let id = reader.u32()?;
    let flags = reader.u32()?;
    if flags & !KNOWN_FLAGS != 0 {
      return Err("unknown option flags".to_owned());
    }
    let count = reader.u32()?;
    let mut strings = Vec::new();
    for _ in 0..count {
      let len = usize::try_from(reader.u32()?)
        .map_err(|_| "string length does not fit".to_owned())?;
      strings.push(
        std::str::from_utf8(reader.take(len)?)
          .map_err(|error| error.to_string())?,
      );
    }
    let request = Self {
      operation,
      id,
      strings,
      payload: reader.remaining,
      options: Options {
        whole_words: flags & FLAG_WHOLE_WORDS != 0,
        unicode_boundaries: flags & FLAG_ASCII_BOUNDARIES == 0,
      },
    };
    request.validate_shape()?;
    Ok(request)
  }

  fn validate_shape(&self) -> Result<()> {
    let valid_strings = match self.operation {
      Operation::New | Operation::Prepare | Operation::FromPrepared => true,
      Operation::IsMatch | Operation::FindIter | Operation::WhichMatch => {
        self.strings.len() == 1
      }
      Operation::ReplaceAll => !self.strings.is_empty(),
      Operation::PatternCount
      | Operation::FindIterBuf
      | Operation::IsMatchBuf
      | Operation::Uax29Boundaries
      | Operation::Free => self.strings.is_empty(),
    };
    let valid_payload = match self.operation {
      Operation::FromPrepared
      | Operation::FindIterBuf
      | Operation::IsMatchBuf
      | Operation::Uax29Boundaries => true,
      Operation::New
      | Operation::Prepare
      | Operation::IsMatch
      | Operation::FindIter
      | Operation::ReplaceAll
      | Operation::PatternCount
      | Operation::WhichMatch
      | Operation::Free => self.payload.is_empty(),
    };
    if !valid_strings || !valid_payload {
      return Err("invalid request fields for operation".to_owned());
    }
    Ok(())
  }

  fn text(&self) -> Result<&str> {
    self
      .strings
      .first()
      .copied()
      .ok_or_else(|| "missing haystack".to_owned())
  }

  fn patterns(&self) -> Vec<String> {
    self.strings.iter().map(|text| (*text).to_owned()).collect()
  }
}

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

fn packed_bytes(values: Vec<u32>) -> Vec<u8> {
  let mut bytes = Vec::with_capacity(values.len().saturating_mul(U32_BYTES));
  for value in values {
    bytes.extend_from_slice(&value.to_le_bytes());
  }
  bytes
}

impl State {
  fn insert(&mut self, matcher: RegexSet) -> Result<Vec<u8>> {
    let id = self
      .next_id
      .checked_add(1)
      .ok_or_else(|| "handle ids exhausted".to_owned())?;
    self.next_id = id;
    self.handles.insert(id, matcher);
    Ok(id.to_le_bytes().to_vec())
  }

  fn matcher(&self, id: u32) -> Result<&RegexSet> {
    self
      .handles
      .get(&id)
      .ok_or_else(|| "unknown matcher id".to_owned())
  }

  fn execute(&mut self, request: &Request<'_>) -> Result<Vec<u8>> {
    match request.operation {
      Operation::New => {
        let matcher = RegexSet::new(request.patterns(), request.options)
          .map_err(|error| error.to_string())?;
        self.insert(matcher)
      }
      Operation::Prepare => {
        RegexSet::prepare(request.patterns(), request.options)
          .map_err(|error| error.to_string())
      }
      Operation::FromPrepared => {
        let matcher = RegexSet::with_prepared(
          request.patterns(),
          request.options,
          request.payload,
        )
        .map_err(|error| error.to_string())?;
        self.insert(matcher)
      }
      Operation::PatternCount => Ok(
        self
          .matcher(request.id)?
          .pattern_count()
          .to_le_bytes()
          .to_vec(),
      ),
      Operation::IsMatch => Ok(
        u32::from(self.matcher(request.id)?.is_match(request.text()?))
          .to_le_bytes()
          .to_vec(),
      ),
      Operation::FindIter => self
        .matcher(request.id)?
        .find_iter_packed(request.text()?)
        .map(packed_bytes)
        .map_err(|error| error.to_string()),
      Operation::ReplaceAll => {
        let (haystack, replacements) = request
          .strings
          .split_first()
          .ok_or_else(|| "missing haystack".to_owned())?;
        let replacements: Vec<String> =
          replacements.iter().map(|text| (*text).to_owned()).collect();
        self
          .matcher(request.id)?
          .replace_all(haystack, &replacements)
          .map(String::into_bytes)
          .map_err(|error| error.to_string())
      }
      Operation::FindIterBuf => self
        .matcher(request.id)?
        .find_iter_packed_buf(request.payload)
        .map(packed_bytes)
        .map_err(|error| error.to_string()),
      Operation::IsMatchBuf => self
        .matcher(request.id)?
        .is_match_buf(request.payload)
        .map(|value| u32::from(value).to_le_bytes().to_vec())
        .map_err(|error| error.to_string()),
      Operation::WhichMatch => Ok(packed_bytes(
        self.matcher(request.id)?.which_match(request.text()?),
      )),
      Operation::Uax29Boundaries => uax29_boundaries(request.payload)
        .map(packed_bytes)
        .map_err(|error| error.to_string()),
      Operation::Free => {
        self
          .handles
          .remove(&request.id)
          .ok_or_else(|| "unknown matcher id".to_owned())?;
        Ok(Vec::new())
      }
    }
  }

  fn run(&mut self) -> u32 {
    self.output = Vec::new();
    let input = mem::take(&mut self.input);
    let result =
      Request::parse(&input).and_then(|request| self.execute(&request));
    self.input = input;
    match result {
      Ok(output) => {
        self.output = output;
        0
      }
      Err(error) => {
        self.output = error.into_bytes();
        1
      }
    }
  }
}

/// Allocate initialized input bytes; the offset remains valid until the next allocation.
// Rust 2024 requires an unsafe export attribute; there are no unsafe operations.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn regex_input_alloc(len: u32) -> u32 {
  STATE.with_borrow_mut(|state| {
    let Ok(len) = usize::try_from(len) else {
      return 0;
    };
    if state.input.capacity() < len {
      state.input.reserve_exact(len - state.input.len());
    }
    state.input.resize(len, 0);
    u32::try_from(state.input.as_ptr().addr()).unwrap_or(0)
  })
}

/// Execute the binary request: status zero indicates success, one indicates UTF-8 error output.
// Only the export attribute is unsafe; input stays in an owned initialized allocation.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn regex_run() -> u32 {
  STATE.with_borrow_mut(State::run)
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
  use super::{Request, State, packed_bytes};

  #[derive(Default)]
  struct Command<'a> {
    op: u32,
    id: u32,
    flags: u32,
    strings: &'a [&'a str],
    payload: &'a [u8],
  }

  impl Command<'_> {
    fn encode(&self) -> Vec<u8> {
      let mut bytes = packed_bytes(vec![
        self.op,
        self.id,
        self.flags,
        u32::try_from(self.strings.len()).unwrap(),
      ]);
      for text in self.strings {
        bytes
          .extend_from_slice(&u32::try_from(text.len()).unwrap().to_le_bytes());
        bytes.extend_from_slice(text.as_bytes());
      }
      bytes.extend_from_slice(self.payload);
      bytes
    }
  }

  fn execute(state: &mut State, command: &Command<'_>) -> Vec<u8> {
    state.input = command.encode();
    let ptr = state.input.as_ptr();
    assert_eq!(state.run(), 0, "{}", String::from_utf8_lossy(&state.output));
    assert_eq!(state.input.as_ptr(), ptr);
    state.output.clone()
  }

  fn scalar(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes.try_into().unwrap())
  }

  fn assert_matcher(state: &mut State, id: u32) {
    let text = ["é😀"];
    let replacements = ["é😀", "a", "b"];
    let empty = [];
    let packed = packed_bytes(vec![0, 0, 1, 1, 1, 3]);
    let cases = [
      (
        4,
        empty.as_slice(),
        b"".as_slice(),
        2_u32.to_le_bytes().to_vec(),
      ),
      (
        5,
        text.as_slice(),
        b"".as_slice(),
        1_u32.to_le_bytes().to_vec(),
      ),
      (6, text.as_slice(), b"".as_slice(), packed.clone()),
      (8, replacements.as_slice(), b"".as_slice(), b"ab".to_vec()),
      (9, empty.as_slice(), "é😀".as_bytes(), packed),
      (
        10,
        empty.as_slice(),
        "é".as_bytes(),
        1_u32.to_le_bytes().to_vec(),
      ),
      (
        17,
        text.as_slice(),
        b"".as_slice(),
        packed_bytes(vec![0, 1]),
      ),
    ];
    for (op, strings, payload, expected) in cases {
      assert_eq!(
        execute(
          state,
          &Command {
            op,
            id,
            strings,
            payload,
            ..Command::default()
          }
        ),
        expected
      );
    }
  }

  #[test]
  fn binary_prepared_and_direct_handles_preserve_unicode_and_ownership() {
    let mut state = State::default();
    let patterns = ["é", "😀"];
    let id = scalar(&execute(
      &mut state,
      &Command {
        op: 1,
        strings: &patterns,
        ..Command::default()
      },
    ));
    let prepared = execute(
      &mut state,
      &Command {
        op: 2,
        strings: &patterns,
        ..Command::default()
      },
    );
    let restored = scalar(&execute(
      &mut state,
      &Command {
        op: 3,
        strings: &patterns,
        payload: &prepared,
        ..Command::default()
      },
    ));
    assert_matcher(&mut state, id);
    assert_matcher(&mut state, restored);
    assert_eq!(
      execute(
        &mut state,
        &Command {
          op: 18,
          payload: "é".as_bytes(),
          ..Command::default()
        }
      ),
      packed_bytes(vec![0, 2])
    );
    assert!(
      execute(
        &mut state,
        &Command {
          op: 16,
          id,
          ..Command::default()
        }
      )
      .is_empty()
    );
    state.input = Command {
      op: 4,
      id,
      ..Command::default()
    }
    .encode();
    assert_eq!(state.run(), 1);
    assert_eq!(state.output, b"unknown matcher id");
    assert_matcher(&mut state, restored);
  }

  #[test]
  fn binary_flags_preserve_regex_boundary_options() {
    for flags in [0, 8, 16, 24] {
      let bytes = Command {
        op: 1,
        flags,
        ..Command::default()
      }
      .encode();
      let options = Request::parse(&bytes).unwrap().options;
      assert_eq!(options.whole_words, flags & 8 != 0);
      assert_eq!(options.unicode_boundaries, flags & 16 == 0);
    }
    let bytes = Command {
      op: 1,
      ..Command::default()
    }
    .encode();
    assert_eq!(
      Request::parse(&bytes).unwrap().options,
      super::Options::default()
    );
  }

  #[test]
  fn binary_prepared_options_preserve_word_boundary_behavior() {
    let mut state = State::default();
    for (flags, expected) in [(0, 1_u32), (8, 0), (16, 1), (24, 1)] {
      let command = Command {
        op: 1,
        flags,
        strings: &["x"],
        ..Command::default()
      };
      let direct = scalar(&execute(&mut state, &command));
      let prepared = execute(&mut state, &Command { op: 2, ..command });
      let restored = scalar(&execute(
        &mut state,
        &Command {
          op: 3,
          payload: &prepared,
          ..command
        },
      ));
      for id in [direct, restored] {
        assert_eq!(
          execute(
            &mut state,
            &Command {
              op: 5,
              id,
              strings: &["éx"],
              ..Command::default()
            }
          ),
          expected.to_le_bytes()
        );
      }
    }
  }

  #[test]
  fn binary_protocol_rejects_malformed_requests_and_invalid_utf8() {
    let valid = Command {
      op: 1,
      strings: &["é"],
      ..Command::default()
    }
    .encode();
    for len in 0..valid.len() {
      assert!(Request::parse(&valid[..len]).is_err());
    }
    let mut invalid_utf8 = Command {
      op: 1,
      strings: &["a"],
      ..Command::default()
    }
    .encode();
    *invalid_utf8.last_mut().unwrap() = 255;
    assert!(Request::parse(&invalid_utf8).is_err());
    assert!(Request::parse(&packed_bytes(vec![1, 0, 0, 1, u32::MAX])).is_err());
    for flags in [1, 2, 4, 32] {
      assert!(
        Request::parse(
          &Command {
            op: 1,
            flags,
            ..Command::default()
          }
          .encode()
        )
        .is_err()
      );
    }
    for command in [
      Command {
        op: 7,
        ..Command::default()
      },
      Command {
        op: 5,
        ..Command::default()
      },
      Command {
        op: 4,
        strings: &["extra"],
        ..Command::default()
      },
      Command {
        op: 4,
        payload: b"extra",
        ..Command::default()
      },
    ] {
      assert!(Request::parse(&command.encode()).is_err());
    }
    let mut state = State::default();
    let id = scalar(&execute(
      &mut state,
      &Command {
        op: 1,
        strings: &["é"],
        ..Command::default()
      },
    ));
    for op in [9, 10, 18] {
      state.input = Command {
        op,
        id,
        payload: &[255],
        ..Command::default()
      }
      .encode();
      assert_eq!(state.run(), 1);
      assert!(
        String::from_utf8_lossy(&state.output).starts_with("Invalid UTF-8:")
      );
    }
  }
}
