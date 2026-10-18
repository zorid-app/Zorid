//! Structural `records` family v1 plaintext, independent of the local intent codec.
//!
//! A decoded payload is NOT authenticated or authorized. The host must bind it to
//! an opened authenticated envelope and independently authorized vault context,
//! then enforce its trusted collection registration and schema before admission.
use super::{encode, Envelope, Error, Id, Operation, Policy, Result, Schema, Scope, State,
    MAX_BYTES, MAX_HISTORY};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Wire {
    family: String,
    format_version: u32,
    id: Id,
    scope: Scope,
    operations: Vec<Operation>,
}

/// Validated structural plaintext; never an authentication capability.
///
/// Fields are private and this type deliberately does not implement Deserialize:
/// every construction path enforces bounds, canonical encoding and validation.
#[derive(Clone, Debug, PartialEq)]
pub struct Payload(Wire);

impl Payload {
    /// Wrap the existing canonical local operation intent without changing its
    /// scope, operation order, causal IDs, schema versions or typed values.
    pub fn from_intent(update_id: Id, intent: &[u8]) -> Result<Self> {
        let envelope = State::decode(intent)?;
        let payload = Self(Wire {
            family: "records".into(), format_version: 1, id: update_id,
            scope: envelope.scope, operations: envelope.operations,
        });
        payload.validate()?;
        Ok(payload)
    }

    /// Parse only structural meaning. Duplicate keys, ignored enum fields,
    /// alternate numeric spellings and all other noncanonical JSON are rejected
    /// by comparison with the typed canonical serialization.
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_BYTES { return Err(Error::Limit); }
        let wire: Wire = serde_json::from_slice(bytes).map_err(|_| Error::Codec)?;
        if wire.family != "records" || wire.format_version != 1 {
            return Err(Error::Codec);
        }
        if encode(&wire)? != bytes { return Err(Error::Codec); }
        let payload = Self(wire);
        payload.validate()?;
        Ok(payload)
    }

    /// Canonical JSON with the entire wrapper included in the byte budget.
    pub fn encode(&self) -> Result<Vec<u8>> {
        self.validate()?;
        encode(&self.0)
    }

    pub fn scope(&self) -> &Scope { &self.0.scope }
    pub fn id(&self) -> &Id { &self.0.id }
    pub fn operations(&self) -> &[Operation] { &self.0.operations }

    /// Recover the existing local intent representation, not a state snapshot.
    pub fn intent(&self) -> Result<Vec<u8>> {
        self.validate()?;
        encode(&Envelope {
            format: 1, scope: self.0.scope.clone(), operations: self.0.operations.clone(),
        })
    }

    /// Compare against the caller's envelope/local context. Matching strings do
    /// not establish authentication; only the host can supply trusted context.
    pub fn check_context(&self, realm: &str, vault: &str, update: &str) -> Result<()> {
        if self.scope().realm.as_str() != realm || self.scope().vault.as_str() != vault
            || self.id().as_str() != update {
            return Err(Error::Scope);
        }
        Ok(())
    }

    fn validate(&self) -> Result<()> {
        self.id().validate()?;
        self.scope().validate()?;
        if self.operations().len() > MAX_HISTORY { return Err(Error::Limit); }
        // Check the transport budget before validating individual operations.
        encode(&self.0)?;
        // Empty-schema scratch space reuses only static operation validation.
        // Never union here: causal cycles, tag context and cross-operation/schema
        // admission belong to the Store's durable unresolved classification, and
        // must not depend on how the sender groups operations into wire batches.
        let schema = Schema {
            collection: self.scope().collection.clone(), version: 1,
            policy: Policy::Local, fields: BTreeMap::new(),
        };
        let structural = State::new(schema, self.scope().clone())?;
        let mut ids = BTreeSet::new();
        for operation in self.operations() {
            if operation.scope != *self.scope() { return Err(Error::Scope); }
            // A wire batch has one immutable row per ID; never silently coalesce
            // duplicate operations when recovering its exact local intent.
            if !ids.insert(&operation.id) { return Err(Error::InvalidOperation); }
            structural.validate_operation(operation)?;
        }
        Ok(())
    }
}
