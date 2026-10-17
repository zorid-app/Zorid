use crate::ContractError;
use serde::{Deserialize, Serialize};
use std::fmt;

/// A non-root, slash-separated logical vault path. Unicode spelling and case
/// are preserved, not normalized. This is not an OS path or a filesystem grant.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct VaultPath(String);

impl VaultPath {
    pub fn new(value: impl Into<String>) -> Result<Self, ContractError> {
        let value = value.into();
        let reject = |reason: &str| ContractError::InvalidPath {
            reason: reason.into(),
        };
        if value.is_empty() {
            return Err(reject("the vault root is not an entry path"));
        }
        if value.starts_with('/') || value.contains('\\') {
            return Err(reject("use relative paths with forward slashes"));
        }
        if value.chars().any(char::is_control) {
            return Err(reject("control characters are not allowed"));
        }
        let mut segments = value.split('/');
        let first = segments
            .next()
            .expect("a nonempty string has a first segment");
        if first.eq_ignore_ascii_case(".zorid") {
            return Err(reject(
                "the root .zorid directory is reserved for app internals",
            ));
        }
        let bytes = first.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            return Err(reject("drive-prefixed paths are not vault-relative"));
        }
        if std::iter::once(first)
            .chain(segments)
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
        {
            return Err(reject("empty and dot segments are not allowed"));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// None denotes the implicit vault root. No synthetic root entry is stored.
    pub fn parent(&self) -> Option<Self> {
        self.0
            .rsplit_once('/')
            .map(|(parent, _)| Self(parent.into()))
    }

    pub fn file_name(&self) -> &str {
        self.0
            .rsplit('/')
            .next()
            .expect("validated paths have a name")
    }

    /// Checks segment boundaries: `a/b` is below `a`, but `ab` is not.
    pub fn is_descendant_of(&self, parent: &Self) -> bool {
        self.0
            .strip_prefix(&parent.0)
            .is_some_and(|suffix| suffix.starts_with('/'))
    }

    /// Rebase a descendant for folder moves without normalizing user spelling.
    /// Returns None for the ancestor itself or an unrelated path.
    pub fn rebase(&self, from: &Self, to: &Self) -> Option<Self> {
        if !self.is_descendant_of(from) {
            return None;
        }
        // Both inputs are validated, and the suffix begins at a segment boundary.
        Some(Self(format!("{}{}", to.0, &self.0[from.0.len()..])))
    }
}

impl TryFrom<String> for VaultPath {
    type Error = ContractError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<VaultPath> for String {
    fn from(value: VaultPath) -> Self {
        value.0
    }
}

impl fmt::Display for VaultPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
