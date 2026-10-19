use crate::{SourceLength, SourcePoint, SourceRange};
use std::ops::Range;
use std::borrow::Cow;
use crate::phases::{AllocationBudget, AllocationKind, ParseFactsJobError};

#[derive(Clone, Copy)]
pub(crate) struct Checkpoint {
    byte: usize,
    utf16: u32,
    line: u32,
    previous_cr: bool,
}

/// Sparse scalar-aligned checkpoints keep offset lookup bounded without a
/// per-byte Unicode table, including a large one-line note full of occurrences.
pub(crate) struct Positions<'a> {
    source: &'a str,
    checkpoints: Cow<'a, [Checkpoint]>,
}
impl<'a> Positions<'a> {
    pub fn new(source: &'a str) -> Self {
        let mut budget = AllocationBudget::unbounded();
        Self::build(source, &mut budget).expect("unbounded position allocation")
    }
    pub(crate) fn build(source: &'a str, budget: &mut AllocationBudget) -> Result<Self, ParseFactsJobError> {
        let mut state = Checkpoint {
            byte: 0,
            utf16: 0,
            line: 0,
            previous_cr: false,
        };
        let mut checkpoints = Vec::new();
        budget.reserve_vec(&mut checkpoints, 1, AllocationKind::Scratch)?;
        checkpoints.push(state);
        for (byte, character) in source.char_indices() {
            if byte - checkpoints.last().unwrap().byte >= 256 {
                state.byte = byte;
                budget.reserve_vec(&mut checkpoints, 1, AllocationKind::Scratch)?;
                checkpoints.push(state);
            }
            state.utf16 += character.len_utf16() as u32;
            if character == '\r' || character == '\n' && !state.previous_cr {
                state.line += 1;
            }
            state.previous_cr = character == '\r';
        }
        state.byte = source.len();
        if checkpoints.last().unwrap().byte != source.len() {
            budget.reserve_vec(&mut checkpoints, 1, AllocationKind::Scratch)?;
            checkpoints.push(state);
        }
        Ok(Self {
            source,
            checkpoints: Cow::Owned(checkpoints),
        })
    }
    pub(crate) fn into_checkpoints(self) -> Vec<Checkpoint> { self.checkpoints.into_owned() }
    pub(crate) fn from_index(source: &'a str, checkpoints: &'a [Checkpoint]) -> Self { Self { source, checkpoints: Cow::Borrowed(checkpoints) } }
    fn at(&self, byte: usize) -> Checkpoint {
        assert!(byte <= self.source.len() && self.source.is_char_boundary(byte));
        let index = self.checkpoints.partition_point(|point| point.byte <= byte) - 1;
        let mut result = self.checkpoints[index];
        for character in self.source[result.byte..byte].chars() {
            result.utf16 += character.len_utf16() as u32;
            if character == '\r' || character == '\n' && !result.previous_cr {
                result.line += 1;
            }
            result.previous_cr = character == '\r';
        }
        result.byte = byte;
        result
    }
    pub fn range(&self, range: Range<usize>) -> SourceRange {
        SourceRange {
            bytes: [range.start as u32, range.end as u32],
            utf16: [self.at(range.start).utf16, self.at(range.end).utf16],
        }
    }
    pub fn point(&self, byte: usize) -> SourcePoint {
        SourcePoint {
            byte: byte as u32,
            utf16: self.at(byte).utf16,
        }
    }
    pub fn line(&self, byte: usize) -> u32 {
        self.at(byte).line
    }
    pub fn length(&self) -> SourceLength {
        SourceLength {
            bytes: self.source.len() as u32,
            utf16: self.at(self.source.len()).utf16,
        }
    }
}

pub(crate) fn line_end(source: &str, start: usize) -> usize {
    source.as_bytes()[start..]
        .iter()
        .position(|byte| matches!(*byte, b'\r' | b'\n'))
        .map_or(source.len(), |offset| start + offset)
}
pub(crate) fn after_line(source: &str, end: usize) -> usize {
    match source.as_bytes().get(end) {
        Some(b'\r') if source.as_bytes().get(end + 1) == Some(&b'\n') => end + 2,
        Some(b'\r' | b'\n') => end + 1,
        _ => end,
    }
}
pub(crate) fn trim_final_newline(source: &str, mut range: Range<usize>) -> Range<usize> {
    if range.end > range.start && source.as_bytes()[range.end - 1] == b'\n' {
        range.end -= 1;
    }
    if range.end > range.start && source.as_bytes()[range.end - 1] == b'\r' {
        range.end -= 1;
    }
    range
}
pub(crate) fn blank(bytes: &mut [u8], range: Range<usize>) {
    for byte in &mut bytes[range] {
        if !matches!(*byte, b'\r' | b'\n') {
            *byte = b' ';
        }
    }
}
