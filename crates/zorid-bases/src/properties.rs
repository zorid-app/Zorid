//! Optional vault-wide value definitions, independent of named note types.
//! The original YAML and unknown settings stay authoritative and unchanged.
use crate::{ExpressionDiagnostic, IndexSnapshotId, PropertyValue, RecordWitness};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use zorid_core::EntryId;
use zorid_index::Generation;

pub const PROPERTY_SETTINGS_PATH: &str = "Properties.yaml";
pub const MAX_PROPERTY_SETTINGS_BYTES: usize = 256 * 1024;
pub const MAX_PROPERTY_DEFINITIONS: usize = 1024;
pub const MAX_PROPERTY_OPTIONS: usize = 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PropertyKind {
    Text,
    Number,
    Checkbox,
    Date,
    Datetime,
    List,
    Tags,
    Link,
    Select,
    Multiselect,
    Status,
    Relation,
    ReverseRelation,
    Rollup,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyOption {
    /// Notes persist this readable value. IDs are optional configuration metadata.
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationDefinition {
    #[serde(default)]
    pub multiple: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_filter: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReverseRelationDefinition {
    pub property: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RollupAggregation {
    Count,
    Sum,
    Average,
    Min,
    Max,
    Values,
    Unique,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollupDefinition {
    pub relation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub property: Option<String>,
    pub aggregation: RollupAggregation,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyDefinition {
    #[serde(rename = "type")]
    pub kind: PropertyKind,
    #[serde(default)]
    pub options: Vec<PropertyOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relation: Option<RelationDefinition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reverse_relation: Option<ReverseRelationDefinition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rollup: Option<RollupDefinition>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyDefinitionDiagnostic {
    pub property: Option<String>,
    pub code: String,
    pub message: String,
}

/// Sealed definitions tied to a real immutable generation. Deserialized caller
/// settings cannot grant relationship authority or masquerade as committed YAML.
#[derive(Clone, Debug)]
pub struct PropertyDefinitions {
    snapshot_id: IndexSnapshotId,
    witness: Option<RecordWitness>,
    source: Option<String>,
    configuration: PropertyValue,
    definitions: BTreeMap<String, PropertyDefinition>,
    diagnostics: Vec<PropertyDefinitionDiagnostic>,
}

impl PropertyDefinitions {
    /// Explicit absence is valid only if this generation has no settings file.
    pub fn absent(generation: &Generation) -> Result<Self, ExpressionDiagnostic> {
        if generation
            .records()
            .any(|r| r.witness().entry().path.as_str() == PROPERTY_SETTINGS_PATH)
        {
            return Err(ExpressionDiagnostic::new(
                "unavailable",
                "The captured Properties.yaml must be read before querying property definitions",
            ));
        }
        Ok(Self {
            snapshot_id: generation.id().clone(),
            witness: None,
            source: None,
            configuration: PropertyValue::Object(Vec::new()),
            definitions: BTreeMap::new(),
            diagnostics: Vec::new(),
        })
    }

    /// Hosts read the retained projection for this generation, not today's file.
    /// The digest check binds the raw settings to its exact indexed revision.
    pub fn from_generation_source(
        generation: &Generation,
        entry_id: &EntryId,
        source: &str,
    ) -> Result<Self, ExpressionDiagnostic> {
        if source.len() > MAX_PROPERTY_SETTINGS_BYTES {
            return Err(ExpressionDiagnostic::new(
                "budget",
                "Property settings exceed source byte budget",
            ));
        }
        let record = generation.record(entry_id).ok_or_else(|| {
            ExpressionDiagnostic::new(
                "stale-source",
                "Property settings are absent from generation",
            )
        })?;
        let entry = record.witness().entry();
        if entry.path.as_str() != PROPERTY_SETTINGS_PATH {
            return Err(ExpressionDiagnostic::new(
                "input",
                "Property settings must be the vault-root Properties.yaml file",
            ));
        }
        record.check_text(source.as_bytes())?;
        let mut result = Self {
            snapshot_id: generation.id().clone(),
            witness: Some(RecordWitness {
                entry_id: entry.id.clone(),
                revision: entry.revision.clone(),
            }),
            source: Some(source.into()),
            configuration: PropertyValue::Null,
            definitions: BTreeMap::new(),
            diagnostics: Vec::new(),
        };
        result.configuration = match zorid_document::parse_yaml_mapping(source) {
            Ok(value) => value,
            Err(error) => {
                result.issue(
                    None,
                    "invalid_property_yaml",
                    format!("Invalid property settings YAML: {:?}", error.code),
                );
                return Ok(result);
            }
        };
        let Some(PropertyValue::Object(entries)) = result.configuration.get("properties") else {
            result.issue(
                None,
                "invalid_property_definitions",
                "Property settings require a properties mapping",
            );
            return Ok(result);
        };
        if entries.len() > MAX_PROPERTY_DEFINITIONS {
            return Err(ExpressionDiagnostic::new(
                "budget",
                "Too many property definitions",
            ));
        }
        // Preserve the ordered source AST; only validated copies enter queries.
        for (name, value) in entries.clone() {
            let parsed = serde_json::to_vec(&value)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<PropertyDefinition>(&bytes).ok());
            match parsed {
                Some(definition) => match validate_definition(&name, &definition) {
                    Ok(()) => {
                        result.definitions.insert(name, definition);
                    }
                    Err(message) => {
                        result.issue(Some(name), "invalid_property_definition", message)
                    }
                },
                None => result.issue(
                    Some(name),
                    "invalid_property_definition",
                    "Invalid or unsupported property definition",
                ),
            }
        }
        // Validate reverse relations before rollups so a rollup cannot retain a
        // reference to an invalid reverse definition removed in this pass.
        for kind in [PropertyKind::ReverseRelation, PropertyKind::Rollup] {
            let invalid = result
                .definitions
                .iter()
                .filter_map(|(name, definition)| {
                    if definition.kind != kind {
                        return None;
                    }
                    let (target, reverse_allowed) = match definition.kind {
                        PropertyKind::ReverseRelation => (
                            &definition
                                .reverse_relation
                                .as_ref()
                                .expect("validated")
                                .property,
                            false,
                        ),
                        PropertyKind::Rollup => (
                            &definition.rollup.as_ref().expect("validated").relation,
                            true,
                        ),
                        _ => unreachable!(),
                    };
                    let valid = result.definitions.get(target).is_some_and(|d| {
                        d.kind == PropertyKind::Relation
                            || (reverse_allowed && d.kind == PropertyKind::ReverseRelation)
                    });
                    (!valid).then(|| name.clone())
                })
                .collect::<Vec<_>>();
            for name in invalid {
                result.definitions.remove(&name);
                result.issue(
                    Some(name),
                    "invalid_property_reference",
                    "Derived property must name an existing relation property",
                );
            }
        }
        Ok(result)
    }
    fn issue(&mut self, property: Option<String>, code: &str, message: impl Into<String>) {
        self.diagnostics.push(PropertyDefinitionDiagnostic {
            property,
            code: code.into(),
            message: message.into(),
        });
    }
    pub fn snapshot_id(&self) -> &IndexSnapshotId {
        &self.snapshot_id
    }
    pub fn witness(&self) -> Option<&RecordWitness> {
        self.witness.as_ref()
    }
    pub fn source(&self) -> Option<&str> {
        self.source.as_deref()
    }
    pub fn configuration(&self) -> &PropertyValue {
        &self.configuration
    }
    pub fn get(&self, name: &str) -> Option<&PropertyDefinition> {
        self.definitions.get(name)
    }
    pub fn iter(&self) -> impl Iterator<Item = (&String, &PropertyDefinition)> {
        self.definitions.iter()
    }
    pub fn diagnostics(&self) -> &[PropertyDefinitionDiagnostic] {
        &self.diagnostics
    }
}

fn valid_name(name: &str) -> bool {
    !name.trim().is_empty() && name.len() <= 512 && !name.chars().any(char::is_control)
}

fn validate_definition(name: &str, definition: &PropertyDefinition) -> Result<(), String> {
    if !valid_name(name) {
        return Err("Property names must be nonempty bounded text".into());
    }
    if definition.options.len() > MAX_PROPERTY_OPTIONS {
        return Err("Too many property options".into());
    }
    let mut values = BTreeSet::new();
    for option in &definition.options {
        if !valid_name(&option.value) || !values.insert(&option.value) {
            return Err("Property options require unique nonempty readable values".into());
        }
    }
    if definition.kind == PropertyKind::Status
        && definition.options.iter().any(|option| {
            option
                .category
                .as_deref()
                .is_some_and(|category| !matches!(category, "todo" | "in-progress" | "done"))
        })
    {
        return Err("Status option category must be todo, in-progress, or done".into());
    }
    match definition.kind {
        PropertyKind::Relation => {
            if let Some(filter) = definition
                .relation
                .as_ref()
                .and_then(|relation| relation.target_filter.as_ref())
            {
                crate::expression::validate(filter)
                    .map_err(|_| "Relation target filter is invalid")?;
            }
        }
        PropertyKind::ReverseRelation => {
            if !definition
                .reverse_relation
                .as_ref()
                .is_some_and(|r| valid_name(&r.property))
            {
                return Err("Reverse relation requires a source relation property".into());
            }
        }
        PropertyKind::Rollup => {
            let rollup = definition
                .rollup
                .as_ref()
                .ok_or("Rollup settings are required")?;
            if !valid_name(&rollup.relation)
                || (rollup.aggregation != RollupAggregation::Count
                    && !rollup.property.as_deref().is_some_and(valid_name))
            {
                return Err(
                    "Rollup requires a relation and a target property (except count)".into(),
                );
            }
        }
        _ => {}
    }
    Ok(())
}
