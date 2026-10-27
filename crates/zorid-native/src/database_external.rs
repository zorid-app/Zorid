//! Pure reconciliation of a saved physical projection with local field identities.
//! This never writes files or assigns membership. The caller must retain the
//! observed physical source, apply the returned patch with both revision guards,
//! and publish through the native no-clobber path. An error preserves the source.
use crate::{Error, Result};
use serde_json::Value;
use std::collections::BTreeMap;
use zorid_document::{parse_markdown_facts, FrontmatterState};
use zorid_store::{
    DatabaseCollection, DatabaseDatatype, DatabaseProjection, DatabaseProjectionKind,
    DatabaseProperty,
};

fn conflict(message: impl Into<String>) -> Error {
    Error::Contract(zorid_core::ContractError::InvalidMutation {
        reason: message.into(),
    })
}

/// Return only authored, unambiguous field edits. A field still equal to its
/// previous projection is untouched even when newer structured state differs.
/// Unknown properties and the body remain owned by the physical document.
/// `_type` is repaired by projection; its text never changes membership.
/// `_id` must match the current identity or the trusted duplicate baseline.
pub(super) fn reconcile(
    collection: &DatabaseCollection,
    projection: &DatabaseProjection,
    source: &str,
) -> Result<BTreeMap<String, Value>> {
    if collection.id != projection.collection_id
        || collection.revision != projection.collection_revision
        || collection.deleted
        || projection.kind == DatabaseProjectionKind::Trash
    {
        return Err(conflict(
            "Collection changed or was deleted before external reconciliation",
        ));
    }
    let facts = parse_markdown_facts(source)
        .map_err(|_| conflict("External collection source exceeds document limits"))?;
    if !matches!(
        facts.frontmatter.state,
        FrontmatterState::Absent | FrontmatterState::Valid
    ) {
        return Err(conflict(
            "External collection frontmatter is invalid; retain it for repair",
        ));
    }
    let actual: BTreeMap<String, Value> = facts
        .properties
        .into_iter()
        .map(|p| {
            Ok((
                p.key,
                serde_json::to_value(p.value)
                    .map_err(|_| conflict("Unsupported external property value"))?,
            ))
        })
        .collect::<Result<_>>()?;
    let desired_id = projection.properties.get("_id");
    if desired_id.and_then(Value::as_str) != Some(projection.entry_id.as_str()) {
        return Err(conflict(
            "Collection projection has an inconsistent entry identity",
        ));
    }
    if actual.get("_id") != desired_id
        && actual.get("_id") != projection.previous_properties.get("_id")
    {
        return Err(conflict(
            "External entry identity changed; retain the original source for repair",
        ));
    }

    // A removed or renamed key remains owned through its last projection.
    // Never turn a note key edit into a collection-wide schema change.
    for key in projection
        .previous_properties
        .keys()
        .chain(projection.previous_keys.iter())
    {
        if matches!(key.as_str(), "_id" | "_type") || projection.properties.contains_key(key) {
            continue;
        }
        if let Some(value) = actual.get(key) {
            if Some(value) != projection.previous_properties.get(key) {
                return Err(conflict(format!(
                    "Retired property {key} was edited externally; retain it for repair"
                )));
            }
        }
    }

    let mut patch = BTreeMap::new();
    for property in &collection.properties {
        let desired = projection
            .properties
            .get(&property.name)
            .ok_or_else(|| conflict("Collection projection is missing a current field"))?;
        let previous = projection.previous_properties.get(&property.name);
        let observed = actual.get(&property.name);
        // Already materialized, unchanged since the baseline, or not yet emitted.
        if observed == Some(desired) || observed == previous {
            continue;
        }
        // A new schema key has no observed baseline; an occupying physical key
        // must not be guessed to be this field. Different simultaneous edits to
        // an existing field likewise require retained-source repair.
        if previous != Some(desired) {
            return Err(conflict(format!(
                "Property {} changed both locally and externally; retain the external source",
                property.name
            )));
        }
        let observed = observed.ok_or_else(|| conflict(format!(
            "Property {} was removed externally; retain the source rather than infer a clear or rename", property.name
        )))?;
        let value = interpret(property, observed)?;
        zorid_store::databases::validate_database_property_value(property, &value)?;
        patch.insert(property.id.clone(), value);
    }
    Ok(patch)
}

fn interpret(property: &DatabaseProperty, value: &Value) -> Result<Value> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    let option = |label: &Value| -> Result<Value> {
        let label = label
            .as_str()
            .ok_or_else(|| conflict(format!("Property {} needs an option label", property.name)))?;
        let matches = property
            .options
            .iter()
            .filter(|option| option.name == label)
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return Err(conflict(format!(
                "Property {} has an unknown or ambiguous option label",
                property.name
            )));
        }
        Ok(Value::String(matches[0].id.clone()))
    };
    match property.datatype {
        DatabaseDatatype::Select | DatabaseDatatype::Status => option(value),
        DatabaseDatatype::MultiSelect => value
            .as_array()
            .ok_or_else(|| {
                conflict(format!(
                    "Property {} needs a list of option labels",
                    property.name
                ))
            })?
            .iter()
            .map(option)
            .collect::<Result<Vec<_>>>()
            .map(Value::Array),
        _ => Ok(value.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use zorid_core::EntryId;
    use zorid_store::DatabaseOption;

    fn map(value: Value) -> BTreeMap<String, Value> {
        serde_json::from_value(value).unwrap()
    }
    fn property(id: &str, name: &str, datatype: DatabaseDatatype) -> DatabaseProperty {
        DatabaseProperty {
            id: id.into(),
            name: name.into(),
            datatype,
            options: vec![],
            default: None,
        }
    }
    fn fixture() -> (DatabaseCollection, DatabaseProjection) {
        let collection = DatabaseCollection {
            id: "collection01".into(),
            name: "Work".into(),
            revision: "schema1".into(),
            deleted: false,
            properties: vec![
                property("number000001", "Estimate", DatabaseDatatype::Number),
                property("date00000001", "Deadline", DatabaseDatatype::Date),
                property("check0000001", "Ready", DatabaseDatatype::Checkbox),
            ],
        };
        let properties = map(
            json!({"_id":"entry1","_type":"Work","Estimate":2,"Deadline":"2026-10-27","Ready":false}),
        );
        let projection = DatabaseProjection {
            entry_id: EntryId::new("entry1").unwrap(),
            collection_id: collection.id.clone(),
            entry_revision: "member1".into(),
            collection_revision: collection.revision.clone(),
            kind: DatabaseProjectionKind::Properties,
            previous_properties: properties.clone(),
            previous_keys: properties.keys().cloned().collect(),
            properties,
            original_path: "Task.md".into(),
        };
        (collection, projection)
    }
    fn source(values: Value) -> String {
        // JSON is a valid YAML mapping; reconciliation does not rewrite its style.
        format!("---\n{}\n---\n# External body 🐈\n", values)
    }
    fn baseline() -> Value {
        json!({"_id":"entry1","_type":"Work","Estimate":2,"Deadline":"2026-10-27","Ready":false})
    }

    #[test]
    fn valid_primitive_edits_are_field_id_patches_and_do_not_mutate_source() {
        let (collection, projection) = fixture();
        let mut values = baseline();
        values["Estimate"] = json!(3.5);
        values["Deadline"] = json!("2028-02-29");
        values["Ready"] = json!(true);
        values["unknown"] = json!({"retained":[1,2]});
        let physical = source(values);
        let original = physical.clone();
        assert_eq!(
            reconcile(&collection, &projection, &physical).unwrap(),
            map(json!({
                "number000001":3.5,"date00000001":"2028-02-29","check0000001":true
            }))
        );
        assert_eq!(physical, original);
    }
    #[test]
    fn unchanged_source_does_not_revert_newer_structured_values() {
        let (collection, mut projection) = fixture();
        projection.properties.insert("Estimate".into(), json!(9));
        assert!(reconcile(&collection, &projection, &source(baseline()))
            .unwrap()
            .is_empty());
        let mut desired = baseline();
        desired["Estimate"] = json!(9);
        assert!(reconcile(&collection, &projection, &source(desired))
            .unwrap()
            .is_empty());
    }
    #[test]
    fn different_field_edits_coexist_but_overlapping_edits_conflict() {
        let (collection, mut projection) = fixture();
        projection.properties.insert("Estimate".into(), json!(9));
        let mut values = baseline();
        values["Ready"] = json!(true);
        assert_eq!(
            reconcile(&collection, &projection, &source(values.clone())).unwrap(),
            map(json!({"check0000001":true}))
        );
        values["Estimate"] = json!(7);
        assert!(reconcile(&collection, &projection, &source(values)).is_err());
    }
    #[test]
    fn invalid_type_date_and_missing_field_preserve_input_as_conflict() {
        let (collection, projection) = fixture();
        for (key, value) in [
            ("Estimate", json!("3")),
            ("Ready", json!("yes")),
            ("Deadline", json!("2027-02-29")),
        ] {
            let mut values = baseline();
            values[key] = value;
            assert!(reconcile(&collection, &projection, &source(values)).is_err());
        }
        let mut values = baseline();
        values.as_object_mut().unwrap().remove("Estimate");
        assert!(reconcile(&collection, &projection, &source(values)).is_err());
    }
    #[test]
    fn explicit_null_is_a_clear_but_membership_text_never_moves_entry() {
        let (collection, projection) = fixture();
        let mut values = baseline();
        values["Estimate"] = Value::Null;
        values["_type"] = json!("Another collection");
        assert_eq!(
            reconcile(&collection, &projection, &source(values)).unwrap(),
            map(json!({"number000001":null}))
        );
    }
    #[test]
    fn identity_tampering_or_removal_is_a_conflict() {
        let (collection, projection) = fixture();
        let mut values = baseline();
        values["_id"] = json!("other");
        assert!(reconcile(&collection, &projection, &source(values)).is_err());
        let mut values = baseline();
        values.as_object_mut().unwrap().remove("_id");
        assert!(reconcile(&collection, &projection, &source(values)).is_err());
    }
    #[test]
    fn trusted_duplicate_and_first_projection_baselines_are_not_external_identity_edits() {
        let (collection, mut projection) = fixture();
        projection
            .previous_properties
            .insert("_id".into(), json!("original"));
        let mut values = baseline();
        values["_id"] = json!("original");
        assert!(reconcile(&collection, &projection, &source(values))
            .unwrap()
            .is_empty());
        projection.previous_properties.clear();
        projection.previous_keys.clear();
        assert!(reconcile(&collection, &projection, "# New body\n")
            .unwrap()
            .is_empty());
    }
    #[test]
    fn renamed_keys_are_not_interpreted_as_a_schema_rename_or_field_assignment() {
        let (mut collection, mut projection) = fixture();
        collection.properties[0].name = "Effort".into();
        projection.properties.remove("Estimate");
        projection.properties.insert("Effort".into(), json!(2));
        assert!(reconcile(&collection, &projection, &source(baseline()))
            .unwrap()
            .is_empty());
        let mut values = baseline();
        values["Estimate"] = json!(4);
        assert!(reconcile(&collection, &projection, &source(values)).is_err());
        let mut values = baseline();
        values["Effort"] = json!(4);
        assert!(reconcile(&collection, &projection, &source(values)).is_err());
    }
    #[test]
    fn stale_schema_deleted_source_and_invalid_yaml_cannot_produce_a_patch() {
        let (mut collection, projection) = fixture();
        collection.revision = "newer".into();
        assert!(reconcile(&collection, &projection, &source(baseline())).is_err());
        collection.revision = projection.collection_revision.clone();
        collection.deleted = true;
        assert!(reconcile(&collection, &projection, &source(baseline())).is_err());
        collection.deleted = false;
        assert!(reconcile(
            &collection,
            &projection,
            "---\nEstimate: 1\nEstimate: 2\n---\nBody"
        )
        .is_err());
    }
    #[test]
    fn selection_labels_map_to_identities_and_ambiguity_is_retained() {
        let (mut collection, mut projection) = fixture();
        let mut select = property("select000001", "Stage", DatabaseDatatype::Select);
        select.options = vec![
            DatabaseOption {
                id: "option000001".into(),
                name: "Open".into(),
                category: None,
                color: None,
            },
            DatabaseOption {
                id: "option000002".into(),
                name: "Done".into(),
                category: None,
                color: None,
            },
        ];
        collection.properties.push(select.clone());
        projection
            .previous_properties
            .insert("Stage".into(), json!("Open"));
        projection.properties.insert("Stage".into(), json!("Open"));
        let mut values = baseline();
        values["Stage"] = json!("Done");
        assert_eq!(
            reconcile(&collection, &projection, &source(values.clone())).unwrap(),
            map(json!({"select000001":"option000002"}))
        );
        values["Stage"] = json!("Unknown");
        assert!(reconcile(&collection, &projection, &source(values)).is_err());
        collection
            .properties
            .last_mut()
            .unwrap()
            .options
            .push(DatabaseOption {
                id: "option000003".into(),
                name: "Done".into(),
                category: None,
                color: None,
            });
        let mut values = baseline();
        values["Stage"] = json!("Done");
        assert!(reconcile(&collection, &projection, &source(values)).is_err());
    }
    #[test]
    fn multiselect_merges_no_guesses_and_rejects_duplicate_labels() {
        let (mut collection, mut projection) = fixture();
        let mut labels = property("labels000001", "Labels", DatabaseDatatype::MultiSelect);
        labels.options = vec![
            DatabaseOption {
                id: "option000001".into(),
                name: "A".into(),
                category: None,
                color: None,
            },
            DatabaseOption {
                id: "option000002".into(),
                name: "B".into(),
                category: None,
                color: None,
            },
        ];
        collection.properties.push(labels);
        projection
            .previous_properties
            .insert("Labels".into(), json!(["A"]));
        projection.properties.insert("Labels".into(), json!(["A"]));
        let mut values = baseline();
        values["Labels"] = json!(["B", "A"]);
        assert_eq!(
            reconcile(&collection, &projection, &source(values.clone())).unwrap(),
            map(json!({"labels000001":["option000002","option000001"]}))
        );
        values["Labels"] = json!(["B", "B"]);
        assert!(reconcile(&collection, &projection, &source(values)).is_err());
    }
}
