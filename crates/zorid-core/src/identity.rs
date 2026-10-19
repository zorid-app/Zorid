use crate::ContractError;
use serde::{Deserialize, Serialize};
use std::fmt;

macro_rules! identifier {
    ($name:ident, $label:literal) => {
        /// An opaque, case-sensitive token. Allocation and uniqueness belong to
        /// the adapter; callers must not derive identities from mutable paths.
        #[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            /// Accepts 1–128 ASCII letters, digits, underscores, or hyphens.
            /// UUID strings and decimal tokens are valid; their meaning stays opaque.
            pub fn new(value: impl Into<String>) -> Result<Self, ContractError> {
                let value = value.into();
                if value.is_empty()
                    || value.len() > 128
                    || !value
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                {
                    return Err(ContractError::InvalidIdentifier {
                        kind: $label.into(),
                    });
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            /// Capacity of this owned String backing only. Object layout,
            /// allocator overhead and process RSS are not included. This is a
            /// read-only accounting observation, never an authority witness.
            pub fn heap_capacity_bytes(&self) -> usize {
                self.0.capacity()
            }
        }

        impl TryFrom<String> for $name {
            type Error = ContractError;
            fn try_from(value: String) -> Result<Self, Self::Error> {
                Self::new(value)
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

identifier!(EntryId, "entry ID");
identifier!(Revision, "revision token");
identifier!(OperationId, "operation ID");

#[cfg(test)]
mod heap_capacity_tests {
    use super::*;
    #[test]
    fn opaque_identifiers_measure_owned_spare_capacity_without_changing_wire_or_identity() {
        let mut source = String::with_capacity(4096);
        source.push_str("stable-token");
        let expected = source.capacity();
        let entry = EntryId::new(source).unwrap();
        assert_eq!(entry.heap_capacity_bytes(), expected);
        assert!(entry.heap_capacity_bytes() > entry.as_str().len());
        assert_eq!(entry, EntryId::new("stable-token").unwrap());
        assert_eq!(serde_json::to_string(&entry).unwrap(), "\"stable-token\"");
        let mut source = String::with_capacity(2048);
        source.push_str("revision");
        let expected = source.capacity();
        let revision = Revision::new(source).unwrap();
        assert_eq!(revision.heap_capacity_bytes(), expected);
        let mut source = String::with_capacity(1024);
        source.push_str("operation");
        let expected = source.capacity();
        let operation = OperationId::new(source).unwrap();
        assert_eq!(operation.heap_capacity_bytes(), expected);
    }
}
