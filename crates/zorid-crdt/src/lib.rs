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

impl TextReplica {
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
