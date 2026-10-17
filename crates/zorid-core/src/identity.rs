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
