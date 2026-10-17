//! Experimental plain-text Yjs v1 interoperability boundary, not a durable vault.
//! Actor IDs must be distinct for concurrent writers (including separate processes).
//! Text positions count UTF-16 units; surrogate-pair splitting is rejected locally.
use yrs::updates::{decoder::Decode, encoder::Encode};
use yrs::{
    ClientID, Doc, GetString, OffsetKind, Options, ReadTxn, StateVector, Text, Transact, Update,
};

pub struct TextReplica {
    doc: Doc,
}

/// Positions are sequential UTF-16 offsets, each relative to the previous edit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TextEdit {
    Insert { index: u32, text: String },
    Delete { index: u32, length: u32 },
}

impl TextReplica {
    /// Validate the whole batch before changing this replica, then capture only
    /// this transaction's operations (not a state-vector diff/delete-set replay).
    pub fn edit(&self, edits: &[TextEdit]) -> Result<Vec<u8>, String> {
        let mut preview = self.text();
        for edit in edits {
            match edit {
                TextEdit::Insert { index, text } => {
                    let at = utf16_byte_offset(&preview, *index)?;
                    preview.insert_str(at, text);
                }
                TextEdit::Delete { index, length } => {
                    let end = index.checked_add(*length).ok_or("text range overflow")?;
                    let start = utf16_byte_offset(&preview, *index)?;
                    let end = utf16_byte_offset(&preview, end)?;
                    preview.replace_range(start..end, "");
                }
            }
        }
        let text = self.doc.get_or_insert_text("content");
        let mut tx = self.doc.transact_mut();
        for edit in edits {
            match edit {
                TextEdit::Insert { index, text: value } if !value.is_empty() => {
                    text.insert(&mut tx, *index, value);
                }
                TextEdit::Delete { index, length } if *length != 0 => {
                    text.remove_range(&mut tx, *index, *length);
                }
                _ => {}
            }
        }
        Ok(tx.encode_update_v1())
    }

    /// Actors whose insertion blocks occur in an update, including blocks with
    /// missing dependencies. Do not use a state vector that omits nonzero starts.
    pub fn update_actors(bytes: &[u8]) -> Result<Vec<u32>, String> {
        let update = Update::decode_v1(bytes).map_err(|e| e.to_string())?;
        let mut actors: Vec<_> = update
            .state_vector_lower()
            .iter()
            .map(|(id, _)| id.get() as u32)
            .collect();
        actors.sort_unstable();
        Ok(actors)
    }

    /// Check currently integrated content belongs to our plain-text root. Pending
    /// dependencies still need this validation again when they become integrated.
    pub fn validate_plain_text(&self) -> Result<(), String> {
        let text = self.doc.get_or_insert_text("content");
        let tx = self.doc.transact();
        if tx
            .root_refs()
            .any(|(name, value)| name != "content" || !matches!(value, yrs::Out::YText(_)))
        {
            return Err("unsupported shared root".into());
        }
        // A root's locally declared type is not encoded in incoming updates.
        // Y.Map("content") items can coexist under this locally typed Y.Text;
        // inspect map storage without changing the root's type declaration.
        let branch: &yrs::branch::Branch = text.as_ref();
        let map = yrs::MapRef::from(yrs::branch::BranchPtr::from(branch));
        if yrs::Map::len(&map, &tx) != 0 {
            return Err("unsupported map content on text root".into());
        }
        if text.diff(&tx, |_| ()).iter().any(|chunk| {
            !matches!(&chunk.insert, yrs::Out::Any(yrs::Any::String(_)))
                || chunk
                    .attributes
                    .as_ref()
                    .is_some_and(|attributes| !attributes.is_empty())
        }) {
            return Err("unsupported rich text or embedded value".into());
        }
        Ok(())
    }
    /// Explicit IDs are for deterministic fixtures. Production actor allocation is
    /// a separate persistence/concurrency contract, not a device ID reused forever.
    pub fn new(actor: u32) -> Self {
        let mut options = Options::with_client_id(ClientID::new(u64::from(actor)));
        options.offset_kind = OffsetKind::Utf16;
        let doc = Doc::with_options(options);
        doc.get_or_insert_text("content");
        Self { doc }
    }

    pub fn text(&self) -> String {
        self.doc
            .get_or_insert_text("content")
            .get_string(&self.doc.transact())
    }

    pub fn insert(&self, index: u32, value: &str) -> Result<(), String> {
        self.check_boundary(index)?;
        self.doc
            .get_or_insert_text("content")
            .insert(&mut self.doc.transact_mut(), index, value);
        Ok(())
    }

    pub fn delete(&self, index: u32, length: u32) -> Result<(), String> {
        let end = index.checked_add(length).ok_or("text range overflow")?;
        self.check_boundary(index)?;
        self.check_boundary(end)?;
        self.doc.get_or_insert_text("content").remove_range(
            &mut self.doc.transact_mut(),
            index,
            length,
        );
        Ok(())
    }

    fn check_boundary(&self, index: u32) -> Result<(), String> {
        let mut offset = 0;
        if index == 0 {
            return Ok(());
        }
        for c in self.text().chars() {
            offset += c.len_utf16() as u32;
            if offset == index {
                return Ok(());
            }
            if offset > index {
                break;
            }
        }
        Err("index is outside text or splits a UTF-16 surrogate pair".into())
    }

    /// This decodes fixture bytes. It is not an untrusted-input resource sandbox.
    pub fn apply(&self, bytes: &[u8]) -> Result<(), String> {
        let update = Update::decode_v1(bytes).map_err(|e| e.to_string())?;
        self.doc
            .transact_mut()
            .apply_update(update)
            .map_err(|e| e.to_string())
    }

    pub fn state_vector(&self) -> Vec<u8> {
        self.doc.transact().state_vector().encode_v1()
    }

    pub fn has_missing_updates(&self) -> bool {
        self.doc.transact().has_missing_updates()
    }

    pub fn snapshot(&self) -> Vec<u8> {
        self.doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    pub fn changes_since(&self, state_vector: &[u8]) -> Result<Vec<u8>, String> {
        let vector = StateVector::decode_v1(state_vector).map_err(|e| e.to_string())?;
        Ok(self.doc.transact().encode_state_as_update_v1(&vector))
    }
}

fn utf16_byte_offset(text: &str, index: u32) -> Result<usize, String> {
    let mut offset = 0;
    for (byte, character) in text.char_indices() {
        if offset == index {
            return Ok(byte);
        }
        offset += character.len_utf16() as u32;
        if offset > index {
            break;
        }
    }
    if offset == index {
        Ok(text.len())
    } else {
        Err("index is outside text or splits a UTF-16 surrogate pair".into())
    }
}
