//! Saved ordinary-note link/relation display values, captured from the same sealed
//! graph and derived rows as candidate discovery. No caller-supplied raw value
//! or filename participates in resolution here.
use crate::properties::{PropertyDefinitions, PropertyKind};
use crate::{
    BaseQueryResult, BaseSnapshot, BaseValue, ExpressionDiagnostic, QueryOptions, RecordWitness,
};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentRelationValues {
    pub witness: RecordWitness,
    pub values: BTreeMap<String, BaseValue>,
    /// Semantic saved raw values, before relation decoding. Hosts may display
    /// typed values only when their current editor value equals this baseline.
    pub edit_values: BTreeMap<String, BaseValue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyTargetsQueryResult {
    pub result: BaseQueryResult,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_relation_values: Option<CurrentRelationValues>,
}

pub(crate) fn capture_current_relation_values(
    snapshot: &BaseSnapshot,
    definitions: &PropertyDefinitions,
    options: &QueryOptions,
    charge: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
) -> Result<Option<CurrentRelationValues>, ExpressionDiagnostic> {
    let Some(id) = options.current_entry_id.as_ref() else {
        return Ok(None);
    };
    let unavailable = || {
        ExpressionDiagnostic::new(
            "unavailable",
            "Saved current-note relation values are unavailable for this captured revision",
        )
    };
    let derived = snapshot.property_values.as_ref().ok_or_else(unavailable)?;
    derived.validate_context(&options.evaluation)?;
    if derived.snapshot_id() != snapshot.snapshot_id()
        || definitions.snapshot_id() != snapshot.snapshot_id()
        || derived.settings_witness() != definitions.witness()
    {
        return Err(ExpressionDiagnostic::new(
            "stale-source",
            "Current relation values belong to a different captured generation",
        ));
    }
    let mut record = None;
    for candidate in snapshot.records() {
        charge(1)?;
        if candidate
            .witness
            .as_ref()
            .is_some_and(|witness| &witness.entry_id == id)
        {
            record = Some(candidate);
            break;
        }
    }
    let record = record.ok_or_else(unavailable)?;
    let witness = record.witness.as_ref().ok_or_else(unavailable)?;
    for issue in &snapshot.metadata_issues {
        charge(1)?;
        if issue.witness == *witness && issue.properties_unavailable {
            return Err(unavailable());
        }
    }
    let row = derived.rows().get(id);
    if row.is_some_and(|row| row.witness != *witness) {
        return Err(ExpressionDiagnostic::new(
            "stale-source",
            "Current relation values belong to a different file revision",
        ));
    }
    let mut captured = CurrentRelationValues {
        witness: witness.clone(),
        values: BTreeMap::new(),
        edit_values: BTreeMap::new(),
    };
    let mut bytes = crate::encoded_size(&captured.witness, options.max_output_bytes)?;
    for (name, definition) in definitions.iter() {
        charge(1)?;
        if !matches!(definition.kind, PropertyKind::Relation | PropertyKind::Link) {
            continue;
        }
        let mut raw = None;
        for (key, value) in &record.properties {
            charge(1)?;
            if key == name {
                raw = Some(value);
                break;
            }
        }
        let Some(raw) = raw else {
            continue;
        };
        let value = row
            .and_then(|row| row.values.get(name))
            .ok_or_else(unavailable)?;
        // Bound the copy before cloning either the saved raw tree or typed value.
        bytes = bytes.saturating_add(crate::encoded_size(
            &(name, raw, value),
            options.max_output_bytes.saturating_sub(bytes),
        )?);
        if bytes > options.max_output_bytes {
            return Err(ExpressionDiagnostic::new(
                "budget",
                "Current relation display values exceed output budget",
            ));
        }
        captured
            .edit_values
            .insert(name.clone(), crate::program::from_property(raw));
        captured.values.insert(name.clone(), value.clone());
    }
    crate::encoded_size(&captured, options.max_output_bytes)?;
    Ok(Some(captured))
}
