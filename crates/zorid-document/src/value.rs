//! Ordered, JSON-shaped property data. Object order is retained recursively for
//! deterministic exact-first, source-order case-insensitive Base lookups.

use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::HashSet;
use std::fmt;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_VALUE_DEPTH: usize = 64;
const INVALID_NUMBER: &str = "property numbers must be finite and integer-valued numbers must be within the JSON safe integer range";

/// Ordinary JSON values whose object members retain their original order.
///
/// Objects are not converted through `serde_json::Value`: its map ordering must
/// not decide which case-insensitive property match wins. Deserialize directly
/// from the transport instead. Deserialization bounds value depth to 64 (root
/// depth zero). Hosts still own byte/node limits; this type does not replace the
/// metadata parser's resource guard.
#[derive(Clone, Debug, PartialEq)]
pub enum PropertyValue {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<Self>),
    Object(Vec<(String, Self)>),
}

impl PropertyValue {
    /// Look up an exact object member. Case-insensitive lookup is Base policy.
    pub fn get(&self, key: &str) -> Option<&Self> {
        match self {
            Self::Object(entries) => entries
                .iter()
                .find_map(|(name, value)| (name == key).then_some(value)),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(value) => Some(value),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Self]> {
        match self {
            Self::Array(values) => Some(values),
            _ => None,
        }
    }

    /// Validate numbers after building values from YAML or another typed source.
    /// Serialization and deserialization enforce this same number policy.
    pub fn validate_json_numbers(&self) -> Result<(), &'static str> {
        // Iteration avoids unbounded call-stack growth even for manually built
        // values. The YAML adapter separately enforces its value-depth budget.
        let mut pending = vec![self];
        while let Some(value) = pending.pop() {
            match value {
                Self::Number(number) => validate_number(number)?,
                Self::Array(values) => pending.extend(values),
                Self::Object(entries) => pending.extend(entries.iter().map(|(_, value)| value)),
                _ => {}
            }
        }
        Ok(())
    }
}

fn validate_number(number: &serde_json::Number) -> Result<(), &'static str> {
    let valid = if let Some(value) = number.as_u64() {
        value <= MAX_SAFE_INTEGER
    } else if let Some(value) = number.as_i64() {
        value >= -(MAX_SAFE_INTEGER as i64) && value <= MAX_SAFE_INTEGER as i64
    } else if let Some(value) = number.as_f64() {
        value.is_finite() && (value.fract() != 0.0 || value.abs() <= MAX_SAFE_INTEGER as f64)
    } else {
        false
    };
    if valid {
        Ok(())
    } else {
        Err(INVALID_NUMBER)
    }
}

impl Serialize for PropertyValue {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Null => serializer.serialize_unit(),
            Self::Bool(value) => serializer.serialize_bool(*value),
            Self::Number(value) => {
                validate_number(value).map_err(serde::ser::Error::custom)?;
                value.serialize(serializer)
            }
            Self::String(value) => serializer.serialize_str(value),
            Self::Array(values) => {
                let mut sequence = serializer.serialize_seq(Some(values.len()))?;
                for value in values {
                    sequence.serialize_element(value)?;
                }
                sequence.end()
            }
            Self::Object(entries) => {
                // The public variant permits manually constructed values. Do not
                // emit ambiguous duplicate-key JSON from those values either.
                let mut keys = HashSet::new();
                let mut map = serializer.serialize_map(Some(entries.len()))?;
                for (key, value) in entries {
                    if !keys.insert(key) {
                        return Err(serde::ser::Error::custom("duplicate property object key"));
                    }
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
        }
    }
}

struct PropertyValueVisitor {
    depth: usize,
}

struct PropertyValueSeed {
    depth: usize,
}

impl<'de> DeserializeSeed<'de> for PropertyValueSeed {
    type Value = PropertyValue;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        if self.depth > MAX_VALUE_DEPTH {
            return Err(de::Error::custom("property value depth exceeds 64"));
        }
        deserializer.deserialize_any(PropertyValueVisitor { depth: self.depth })
    }
}

impl<'de> Visitor<'de> for PropertyValueVisitor {
    type Value = PropertyValue;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("JSON property data with unique object keys and safe finite numbers")
    }

    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(PropertyValue::Null)
    }

    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(PropertyValue::Null)
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Self::Value, E> {
        Ok(PropertyValue::Bool(value))
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
        self.number(value.into())
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
        self.number(value.into())
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
        self.number(serde_json::Number::from_f64(value).ok_or_else(|| E::custom(INVALID_NUMBER))?)
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
        Ok(PropertyValue::String(value.to_owned()))
    }

    fn visit_string<E: de::Error>(self, value: String) -> Result<Self::Value, E> {
        Ok(PropertyValue::String(value))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Self::Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element_seed(PropertyValueSeed {
            depth: self.depth + 1,
        })? {
            values.push(value);
        }
        Ok(PropertyValue::Array(values))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut entries = Vec::new();
        let mut keys = HashSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !keys.insert(key.clone()) {
                return Err(de::Error::custom("duplicate property object key"));
            }
            entries.push((
                key,
                map.next_value_seed(PropertyValueSeed {
                    depth: self.depth + 1,
                })?,
            ));
        }
        Ok(PropertyValue::Object(entries))
    }
}

impl PropertyValueVisitor {
    fn number<E: de::Error>(self, value: serde_json::Number) -> Result<PropertyValue, E> {
        validate_number(&value).map_err(E::custom)?;
        Ok(PropertyValue::Number(value))
    }
}

impl<'de> Deserialize<'de> for PropertyValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        PropertyValueSeed { depth: 0 }.deserialize(deserializer)
    }
}

#[cfg(test)]
mod tests {
    use super::PropertyValue;

    #[test]
    fn recursive_order_survives_plain_json_round_trip() {
        let source = r#"{"z":{"Title":"first","title":"second"},"a":[{"b":null,"A":true}]}"#;
        let value: PropertyValue = serde_json::from_str(source).unwrap();
        assert_eq!(serde_json::to_string(&value).unwrap(), source);
        let PropertyValue::Object(nested) = value.get("z").unwrap() else {
            panic!("expected nested object");
        };
        assert_eq!(
            nested
                .iter()
                .map(|(key, _)| key.as_str())
                .collect::<Vec<_>>(),
            ["Title", "title"]
        );
        assert_eq!(nested[0].1.as_str(), Some("first"));
        assert_eq!(value.get("a").unwrap().as_array().unwrap().len(), 1);
    }

    #[test]
    fn quoted_and_prototype_like_keys_are_data() {
        let source = r#"{"__proto__":{"polluted":true},"constructor":"literal","quoted\"key":"value","a\u0062":null}"#;
        let value: PropertyValue = serde_json::from_str(source).unwrap();
        assert_eq!(
            value.get("constructor").and_then(PropertyValue::as_str),
            Some("literal")
        );
        assert_eq!(
            value.get("quoted\"key").and_then(PropertyValue::as_str),
            Some("value")
        );
        assert_eq!(value.get("ab"), Some(&PropertyValue::Null));
        assert_eq!(
            value.get("__proto__").unwrap().get("polluted"),
            Some(&PropertyValue::Bool(true))
        );
    }

    #[test]
    fn duplicates_are_rejected_at_every_depth_after_key_decoding() {
        for source in [r#"{"a":1,"a":2}"#, r#"[{"a":1,"\u0061":2}]"#] {
            assert!(
                serde_json::from_str::<PropertyValue>(source).is_err(),
                "{source}"
            );
        }
        let duplicate = PropertyValue::Object(vec![
            ("a".into(), PropertyValue::Null),
            ("a".into(), PropertyValue::Bool(true)),
        ]);
        assert!(serde_json::to_string(&duplicate).is_err());
    }

    #[test]
    fn json_value_depth_is_bounded_before_stack_growth() {
        let allowed = format!("{}0{}", "[".repeat(64), "]".repeat(64));
        assert!(serde_json::from_str::<PropertyValue>(&allowed).is_ok());
        let excessive = format!("{}0{}", "[".repeat(65), "]".repeat(65));
        let error = serde_json::from_str::<PropertyValue>(&excessive).unwrap_err();
        assert!(error
            .to_string()
            .contains("property value depth exceeds 64"));
    }

    #[test]
    fn safe_integer_boundaries_and_finite_fractions_are_enforced() {
        for source in ["9007199254740991", "-9007199254740991", "1.25", "1e-100"] {
            let value: PropertyValue = serde_json::from_str(source).unwrap();
            value.validate_json_numbers().unwrap();
        }
        for source in [
            "9007199254740992",
            "-9007199254740992",
            "9007199254740992.0",
            "1e100",
            "1e400",
            "NaN",
        ] {
            assert!(
                serde_json::from_str::<PropertyValue>(source).is_err(),
                "{source}"
            );
        }
        let unsafe_value =
            PropertyValue::Array(vec![PropertyValue::Number(9_007_199_254_740_992u64.into())]);
        assert!(unsafe_value.validate_json_numbers().is_err());
        assert!(serde_json::to_string(&unsafe_value).is_err());
        assert!(serde_json::Number::from_f64(f64::INFINITY).is_none());
        assert!(serde_json::Number::from_f64(f64::NAN).is_none());
    }
}
