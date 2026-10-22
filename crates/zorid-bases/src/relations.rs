//! Read-only relations, reverse relations and rollups over one sealed snapshot.
//! Links remain readable source data; derived identities never rewrite notes.
use crate::{
    expression::{BasesFile, BasesTimezone},
    properties::{
        PropertyDefinitionDiagnostic, PropertyDefinitions, PropertyKind, RollupAggregation,
    },
    BaseClockDependency, BaseSnapshot, BaseValue, DetachedRecord, EvaluationOptions,
    ExpressionDiagnostic, IndexSnapshotId, PropertyValue, QueryOptions, RecordWitness,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use zorid_core::{EntryId, Revision};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationTarget {
    pub entry_id: EntryId,
    pub revision: Revision,
    pub path: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyRelationDiagnostic {
    pub witness: RecordWitness,
    pub property: String,
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyRelationRow {
    pub witness: RecordWitness,
    pub values: BTreeMap<String, BaseValue>,
}

/// Produced only from a real graph plus generation-verified settings. Its map
/// participates in ordinary query evaluation, never a second frontend evaluator.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyRelationValues {
    snapshot_id: IndexSnapshotId,
    settings_witness: Option<RecordWitness>,
    property_names: Vec<String>,
    read_only_property_names: BTreeSet<String>,
    relation_targets: BTreeMap<String, Vec<RelationTarget>>,
    rows: BTreeMap<EntryId, PropertyRelationRow>,
    diagnostics: Vec<PropertyRelationDiagnostic>,
    definition_diagnostics: Vec<PropertyDefinitionDiagnostic>,
    clock_dependency: BaseClockDependency,
    evaluation_clock_ms: i64,
    evaluation_timezone: String,
    evaluation_random_seed: Option<u64>,
    steps_used: usize,
}

impl PropertyRelationValues {
    pub fn snapshot_id(&self) -> &IndexSnapshotId {
        &self.snapshot_id
    }
    pub fn settings_witness(&self) -> Option<&RecordWitness> {
        self.settings_witness.as_ref()
    }
    pub fn rows(&self) -> &BTreeMap<EntryId, PropertyRelationRow> {
        &self.rows
    }
    pub fn diagnostics(&self) -> &[PropertyRelationDiagnostic] {
        &self.diagnostics
    }
    pub fn definition_diagnostics(&self) -> &[PropertyDefinitionDiagnostic] {
        &self.definition_diagnostics
    }
    pub fn steps_used(&self) -> usize {
        self.steps_used
    }
    pub fn clock_dependency(&self) -> BaseClockDependency {
        self.clock_dependency
    }
    pub fn property_names(&self) -> impl Iterator<Item = &str> {
        self.property_names.iter().map(String::as_str)
    }
    pub(crate) fn is_read_only_property(&self, name: &str) -> bool {
        self.read_only_property_names.contains(name)
    }
    pub fn relation_targets(&self) -> &BTreeMap<String, Vec<RelationTarget>> {
        &self.relation_targets
    }
    pub(crate) fn validate_context(
        &self,
        options: &EvaluationOptions,
    ) -> Result<(), ExpressionDiagnostic> {
        if self.evaluation_clock_ms != options.clock_ms
            || self.evaluation_timezone != options.timezone
            || self.evaluation_random_seed != options.random_seed
        {
            return Err(ExpressionDiagnostic::new("stale-source", "Derived property values require the captured clock, timezone and random seed; prepare them again for this invocation"));
        }
        Ok(())
    }
    pub(crate) fn attach(
        &self,
        file: &mut BasesFile,
        timezone: &BasesTimezone,
    ) -> Result<(), ExpressionDiagnostic> {
        let Some(witness) = file.witness.as_ref() else {
            return Ok(());
        };
        let Some(row) = self.rows.get(&witness.entry_id) else {
            return Ok(());
        };
        if row.witness != *witness {
            return Err(ExpressionDiagnostic::new(
                "stale-source",
                "Derived properties belong to a different file revision",
            ));
        }
        for (name, value) in &row.values {
            file.properties.insert(
                name.clone(),
                crate::expression::runtime_from_base_value(value, timezone)?,
            );
        }
        Ok(())
    }
}

struct Budget<'a> {
    used: usize,
    maximum: usize,
    options: &'a QueryOptions,
    output_bytes: usize,
}
impl Budget<'_> {
    fn charge(&mut self, work: usize) -> Result<(), ExpressionDiagnostic> {
        if self
            .options
            .evaluation
            .cancellation
            .as_ref()
            .is_some_and(|c| c.is_cancelled())
        {
            return Err(ExpressionDiagnostic::new("cancelled", "Query cancelled"));
        }
        self.used = self
            .used
            .checked_add(work)
            .filter(|n| *n <= self.maximum)
            .ok_or_else(|| {
                ExpressionDiagnostic::new("budget", "Property relations exceed query work budget")
            })?;
        Ok(())
    }
    fn keep<T: Serialize>(&mut self, value: &T) -> Result<(), ExpressionDiagnostic> {
        let bytes = crate::encoded_size(value, self.options.max_output_bytes)?;
        self.charge(1 + bytes / 64)?;
        self.output_bytes = self
            .output_bytes
            .checked_add(bytes + 64)
            .filter(|n| *n <= self.options.max_output_bytes)
            .ok_or_else(|| {
                ExpressionDiagnostic::new("budget", "Property relations exceed output byte budget")
            })?;
        Ok(())
    }
    fn evaluation(&self) -> EvaluationOptions {
        let mut options = self.options.evaluation.clone();
        options.max_steps = self
            .maximum
            .saturating_sub(self.used)
            .min(crate::MAX_EXPRESSION_STEPS);
        options.formulas.clear();
        options.current_record = None;
        options
    }
}

#[derive(Clone, Debug)]
struct RelationState {
    value: BaseValue,
    targets: Vec<EntryId>,
    valid: bool,
}
type RelationKey = (EntryId, String);

fn error(code: &str, message: impl Into<String>) -> BaseValue {
    BaseValue::Error {
        code: code.into(),
        message: message.into(),
    }
}
fn issue(
    diagnostics: &mut Vec<PropertyRelationDiagnostic>,
    record: &DetachedRecord,
    property: &str,
    code: &str,
    message: &str,
    budget: &mut Budget<'_>,
) -> Result<(), ExpressionDiagnostic> {
    let diagnostic = PropertyRelationDiagnostic {
        witness: record.witness.as_ref().expect("sealed record").clone(),
        property: property.into(),
        code: code.into(),
        message: message.into(),
    };
    budget.keep(&diagnostic)?;
    diagnostics.push(diagnostic);
    Ok(())
}
fn raw<'a>(record: &'a DetachedRecord, name: &str) -> Option<&'a PropertyValue> {
    record
        .properties
        .iter()
        .find_map(|(key, value)| (key == name).then_some(value))
}

/// Wiki links are decoded into semantic destinations before the *shared* index
/// resolver is called. Bare vault paths are also accepted. An option label or
/// path is never treated as an immutable foreign key.
fn destination(value: &str) -> Result<(String, Option<String>), &'static str> {
    let value = value.trim();
    if value.is_empty() {
        return Err("Relation targets must be nonempty links");
    }
    if let Some(inner) = value.strip_prefix("[[").and_then(|s| s.strip_suffix("]]")) {
        let (path, display) = inner
            .split_once('|')
            .map_or((inner, None), |(path, display)| {
                (path, Some(display.to_string()))
            });
        if path.trim().is_empty() {
            return Err("Relation targets must name a file");
        }
        return Ok((path.into(), display));
    }
    if value.starts_with('[') || value.starts_with("![[") {
        return Err("Relations accept readable wiki links or vault paths");
    }
    Ok((value.into(), None))
}

/// Derive relationships using exactly the snapshot's immutable resolver. A
/// broken target remains a Link with target:null; no cascading mutations occur.
pub fn query_property_relations(
    snapshot: &BaseSnapshot,
    definitions: &PropertyDefinitions,
    options: &QueryOptions,
) -> Result<PropertyRelationValues, ExpressionDiagnostic> {
    if snapshot.snapshot_id() != definitions.snapshot_id() {
        return Err(ExpressionDiagnostic::new(
            "stale-source",
            "Property definitions belong to a different index generation",
        ));
    }
    if options.max_steps == 0
        || options.max_steps > crate::MAX_QUERY_STEPS
        || options.max_output_bytes == 0
        || options.max_output_bytes > crate::MAX_QUERY_OUTPUT_BYTES
    {
        return Err(ExpressionDiagnostic::new(
            "budget",
            "Invalid property relations budget",
        ));
    }
    let mut budget = Budget {
        used: 0,
        maximum: options.max_steps,
        options,
        output_bytes: 0,
    };
    budget.charge(1)?;
    let mut result = PropertyRelationValues {
        snapshot_id: snapshot.snapshot_id().clone(),
        settings_witness: definitions.witness().cloned(),
        property_names: definitions.iter().map(|(name, _)| name.clone()).collect(),
        read_only_property_names: definitions
            .iter()
            .filter(|(_, definition)| {
                matches!(
                    definition.kind,
                    PropertyKind::ReverseRelation | PropertyKind::Rollup
                )
            })
            .map(|(name, _)| name.clone())
            .collect(),
        relation_targets: BTreeMap::new(),
        rows: BTreeMap::new(),
        diagnostics: Vec::new(),
        definition_diagnostics: definitions.diagnostics().to_vec(),
        clock_dependency: BaseClockDependency::None,
        evaluation_clock_ms: options.evaluation.clock_ms,
        evaluation_timezone: options.evaluation.timezone.clone(),
        evaluation_random_seed: options.evaluation.random_seed,
        steps_used: 0,
    };
    budget.keep(&result.property_names)?;
    budget.keep(&result.read_only_property_names)?;
    budget.keep(&result.definition_diagnostics)?;
    for (_, definition) in definitions.iter() {
        if let Some(filter) = definition
            .relation
            .as_ref()
            .and_then(|relation| relation.target_filter.as_ref())
        {
            let mut failure = None;
            let dependency = crate::expression::clock_dependency(filter, &mut |work| match budget
                .charge(work)
            {
                Ok(()) => Some(()),
                Err(error) => {
                    failure = Some(error);
                    None
                }
            });
            if let Some(error) = failure {
                return Err(error);
            }
            result.clock_dependency = result.clock_dependency.join(dependency);
        }
    }
    let timezone = BasesTimezone::from_setting(Some(&options.evaluation.timezone))
        .map_err(|message| ExpressionDiagnostic::new("input", message))?;
    for record in &snapshot.records {
        for (name, definition) in definitions.iter().filter(|(_, definition)| {
            !matches!(
                definition.kind,
                PropertyKind::Link
                    | PropertyKind::Relation
                    | PropertyKind::ReverseRelation
                    | PropertyKind::Rollup
            )
        }) {
            budget.charge(1)?;
            let Some(value) = raw(record, name) else {
                continue;
            };
            let witness = record.witness.as_ref().ok_or_else(|| {
                ExpressionDiagnostic::new(
                    "unavailable",
                    "Property definitions require file witnesses",
                )
            })?;
            budget.keep(value)?;
            let (value, diagnostic) =
                crate::properties::scalar_property_value(value, definition, &timezone)?;
            if let Some(message) = diagnostic {
                issue(
                    &mut result.diagnostics,
                    record,
                    name,
                    "incompatible_property_value",
                    message,
                    &mut budget,
                )?;
            }
            budget.keep(&(witness, name, &value))?;
            result
                .rows
                .entry(witness.entry_id.clone())
                .or_insert_with(|| PropertyRelationRow {
                    witness: witness.clone(),
                    values: BTreeMap::new(),
                })
                .values
                .insert(name.clone(), value);
        }
    }
    // Membership constraints run before reverse/rollup graph construction.
    // Expose an explicit dependency error rather than pretending these fields
    // are absent and silently excluding every candidate. Final values replace
    // these temporary sentinels after membership has been resolved.
    for record in &snapshot.records {
        for (name, _) in definitions.iter().filter(|(_, definition)| {
            matches!(
                definition.kind,
                PropertyKind::ReverseRelation | PropertyKind::Rollup
            )
        }) {
            budget.charge(1)?;
            let witness = record.witness.as_ref().ok_or_else(|| {
                ExpressionDiagnostic::new(
                    "unavailable",
                    "Derived property definitions require file witnesses",
                )
            })?;
            let value = error("unavailable", "Target filters cannot read derived reverse relations or rollups before relationship graph construction");
            budget.keep(&(witness, name, &value))?;
            result
                .rows
                .entry(witness.entry_id.clone())
                .or_insert_with(|| PropertyRelationRow {
                    witness: witness.clone(),
                    values: BTreeMap::new(),
                })
                .values
                .insert(name.clone(), value);
        }
    }
    let has_relations = definitions.iter().any(|(_, d)| {
        matches!(
            d.kind,
            PropertyKind::Link
                | PropertyKind::Relation
                | PropertyKind::ReverseRelation
                | PropertyKind::Rollup
        )
    });
    if !has_relations {
        result.steps_used = budget.used;
        crate::encoded_size(&result, options.max_output_bytes)?;
        return Ok(result);
    }
    let graph = snapshot.relationships.as_ref().ok_or_else(|| {
        ExpressionDiagnostic::new(
            "unavailable",
            "Relations require a Rust-owned generation graph",
        )
    })?;
    let resolver = graph.resolver_checked(&mut |work| budget.charge(work))?;
    let owned =
        crate::graph::OwnedRelationships::new(graph, &snapshot.metadata_issues, &mut |work| {
            budget.charge(work)
        })?;
    let relationships = crate::graph::PreparedRelationships::borrowed(&owned);
    let mut by_id = HashMap::new();
    for record in &snapshot.records {
        budget.charge(1)?;
        let witness = record.witness.as_ref().ok_or_else(|| {
            ExpressionDiagnostic::new("unavailable", "Relations require file witnesses")
        })?;
        by_id.insert(witness.entry_id.clone(), record);
    }
    let unavailable = snapshot
        .metadata_issues
        .iter()
        .filter(|i| i.properties_unavailable)
        .map(|i| &i.witness.entry_id)
        .collect::<BTreeSet<_>>();
    let target_filter_files = if definitions.iter().any(|(_, definition)| {
        definition
            .relation
            .as_ref()
            .and_then(|relation| relation.target_filter.as_ref())
            .is_some_and(|source| crate::expression::uses_relationships(source))
    }) {
        Some(crate::files::hydrate(
            &snapshot.records,
            Some(&relationships),
            None,
            Some(&result),
            &timezone,
            &mut |work| budget.charge(work),
            &mut |_| Ok(()),
        )?)
    } else {
        None
    };
    // Picker candidates and persisted relation validation use the same Rust
    // predicate evaluation. No frontend expression approximation is necessary.
    let mut allowed = BTreeMap::<String, BTreeSet<EntryId>>::new();
    for (name, definition) in definitions
        .iter()
        .filter(|(_, d)| d.kind == PropertyKind::Relation)
    {
        let settings = definition.relation.clone().unwrap_or_default();
        let mut targets = Vec::new();
        let mut accepted = BTreeSet::new();
        for record in &snapshot.records {
            budget.charge(1)?;
            let witness = record.witness.as_ref().expect("sealed record");
            if !record.path.to_ascii_lowercase().ends_with(".md")
                || unavailable.contains(&witness.entry_id)
            {
                continue;
            }
            if let Some(filter) = &settings.target_filter {
                let invocation = budget.evaluation();
                if invocation.max_steps == 0 {
                    return Err(ExpressionDiagnostic::new(
                        "budget",
                        "Relation target filtering exhausted its work budget",
                    ));
                }
                let (value, used) = crate::with_session_files(
                    filter,
                    record,
                    &invocation,
                    Some(&relationships),
                    None,
                    Some(&result),
                    target_filter_files.clone(),
                    |session| {
                        let value = session.evaluate(filter);
                        Ok((value, session.steps_used()))
                    },
                )?;
                budget.charge(used)?;
                match value {
                    Ok(BaseValue::Boolean { value: true }) => {}
                    Ok(BaseValue::Boolean { value: false }) | Ok(BaseValue::Null) => continue,
                    Err(error) if matches!(error.code.as_str(), "budget" | "cancelled") => {
                        return Err(error)
                    }
                    Err(error) => {
                        issue(
                            &mut result.diagnostics,
                            record,
                            name,
                            "relation_target_filter",
                            &error.message,
                            &mut budget,
                        )?;
                        continue;
                    }
                    _ => {
                        issue(
                            &mut result.diagnostics,
                            record,
                            name,
                            "relation_target_filter",
                            "Relation target filter did not produce a boolean value",
                            &mut budget,
                        )?;
                        continue;
                    }
                }
            }
            if targets.len() >= options.max_rows {
                return Err(ExpressionDiagnostic::new(
                    "budget",
                    "Relation target picker exceeds its candidate limit; narrow the target filter",
                ));
            }
            let target = RelationTarget {
                entry_id: witness.entry_id.clone(),
                revision: witness.revision.clone(),
                path: record.path.clone(),
                label: record
                    .path
                    .rsplit('/')
                    .next()
                    .unwrap_or(&record.path)
                    .strip_suffix(".md")
                    .unwrap_or_else(|| record.path.rsplit('/').next().unwrap_or(&record.path))
                    .into(),
            };
            budget.keep(&target)?;
            accepted.insert(witness.entry_id.clone());
            targets.push(target);
        }
        allowed.insert(name.clone(), accepted);
        result.relation_targets.insert(name.clone(), targets);
    }
    drop(target_filter_files);
    let mut states = BTreeMap::<RelationKey, RelationState>::new();
    let mut incoming = BTreeMap::<RelationKey, Vec<EntryId>>::new();
    for record in &snapshot.records {
        let witness = record.witness.as_ref().expect("sealed record");
        for (name, definition) in definitions
            .iter()
            .filter(|(_, d)| matches!(d.kind, PropertyKind::Link | PropertyKind::Relation))
        {
            budget.charge(1)?;
            let settings = definition.relation.clone().unwrap_or_default();
            let key = (witness.entry_id.clone(), name.clone());
            if unavailable.contains(&witness.entry_id) {
                states.insert(
                    key,
                    RelationState {
                        value: error(
                            "unavailable",
                            "Relation metadata is unavailable for this revision",
                        ),
                        targets: Vec::new(),
                        valid: false,
                    },
                );
                continue;
            }
            if let Some(value) = raw(record, name) {
                budget.keep(value)?;
            }
            let raw_values = match raw(record, name) {
                None | Some(PropertyValue::Null) => Vec::new(),
                Some(PropertyValue::String(value)) => vec![PropertyValue::String(value.clone())],
                Some(PropertyValue::Array(values)) => values.clone(),
                Some(value) => vec![value.clone()],
            };
            if !settings.multiple && raw_values.len() > 1 {
                issue(
                    &mut result.diagnostics,
                    record,
                    name,
                    "relation_cardinality",
                    "Single relation contains multiple values; source values are preserved",
                    &mut budget,
                )?;
                states.insert(
                    key,
                    RelationState {
                        value: error(
                            "relation_cardinality",
                            "Single relation contains multiple values",
                        ),
                        targets: Vec::new(),
                        valid: false,
                    },
                );
                continue;
            }
            let mut values = Vec::new();
            let mut targets = Vec::new();
            let mut seen_targets = BTreeSet::new();
            let mut valid = true;
            for value in &raw_values {
                budget.charge(1)?;
                let parsed = value
                    .as_str()
                    .ok_or("Relation targets must be links")
                    .and_then(destination);
                let (path, display) = match parsed {
                    Ok(value) => value,
                    Err(message) => {
                        valid = false;
                        issue(
                            &mut result.diagnostics,
                            record,
                            name,
                            "invalid_relation",
                            message,
                            &mut budget,
                        )?;
                        values.push(error("invalid_relation", message));
                        continue;
                    }
                };
                let candidates =
                    match resolver.candidates_checked(&witness.entry_id, &path, &mut |work| {
                        budget.charge(work)
                    }) {
                        Ok(candidates) => candidates,
                        Err(error) if matches!(error.code.as_str(), "budget" | "cancelled") => {
                            return Err(error)
                        }
                        Err(_) => Vec::new(),
                    };
                // Match the existing resolver's deterministic first-candidate
                // policy. Identity is the selected EntryId, never the raw path.
                let target = candidates.first().copied();
                let external = zorid_index::is_external_destination(&path).unwrap_or(false);
                let accepted = if definition.kind == PropertyKind::Link {
                    target.is_some() || external
                } else {
                    target.is_some_and(|target| allowed[name].contains(&target.id))
                };
                if target.is_some() && !accepted {
                    issue(&mut result.diagnostics, record, name, "relation_target_filter", "Related file does not satisfy its target filter or its metadata is unavailable", &mut budget)?;
                }
                if target.is_none() && !external {
                    issue(
                        &mut result.diagnostics,
                        record,
                        name,
                        "unresolved_relation",
                        "Related file cannot be resolved in this generation",
                        &mut budget,
                    )?;
                }
                if external && definition.kind == PropertyKind::Relation {
                    issue(
                        &mut result.diagnostics,
                        record,
                        name,
                        "invalid_relation",
                        "Relation targets must be notes; external URL is preserved",
                        &mut budget,
                    )?;
                }
                valid &= accepted;
                let subpath = crate::expression::link_subpath(&path);
                let link = BaseValue::Link {
                    subpath,
                    // The display projection uses the resolved path; the note
                    // keeps its original short link and optional alias.
                    path: target.map_or(path, |entry| entry.path.as_str().to_string()),
                    target: target.map(|entry| RecordWitness {
                        entry_id: entry.id.clone(),
                        revision: entry.revision.clone(),
                    }),
                    display,
                    display_value: None,
                    external,
                };
                budget.keep(&link)?;
                values.push(link);
                if let Some(target) = target.filter(|_| accepted) {
                    let target = &target.id;
                    if seen_targets.insert(target.clone()) {
                        targets.push(target.clone());
                        let reverse = incoming.entry((target.clone(), name.clone())).or_default();
                        reverse.push(witness.entry_id.clone());
                    }
                }
            }
            let value = if settings.multiple {
                BaseValue::List { value: values }
            } else {
                values.into_iter().next().unwrap_or(BaseValue::Null)
            };
            budget.keep(&value)?;
            states.insert(
                key,
                RelationState {
                    value,
                    targets,
                    valid,
                },
            );
        }
    }
    for record in &snapshot.records {
        let witness = record.witness.as_ref().expect("sealed record");
        for (name, definition) in definitions
            .iter()
            .filter(|(_, d)| d.kind == PropertyKind::ReverseRelation)
        {
            budget.charge(1)?;
            let source = &definition
                .reverse_relation
                .as_ref()
                .expect("validated definition")
                .property;
            let targets = incoming
                .get(&(witness.entry_id.clone(), source.clone()))
                .cloned()
                .unwrap_or_default();
            let value = if !graph.complete() || !unavailable.is_empty() {
                error("unavailable", "Reverse relation coverage is incomplete")
            } else {
                BaseValue::List {
                    value: targets
                        .iter()
                        .map(|id| {
                            let source = by_id[id];
                            BaseValue::Link {
                                subpath: None,
                                path: source.path.clone(),
                                target: source.witness.clone(),
                                display: None,
                                display_value: None,
                                external: false,
                            }
                        })
                        .collect(),
                }
            };
            budget.keep(&value)?;
            states.insert(
                (witness.entry_id.clone(), name.clone()),
                RelationState {
                    value,
                    targets,
                    valid: graph.complete() && unavailable.is_empty(),
                },
            );
        }
    }
    for record in &snapshot.records {
        let witness = record.witness.as_ref().expect("sealed record");
        let mut values = BTreeMap::new();
        for (name, definition) in definitions.iter() {
            budget.charge(1)?;
            match definition.kind {
                PropertyKind::Link | PropertyKind::Relation | PropertyKind::ReverseRelation => {
                    values.insert(
                        name.clone(),
                        states[&(witness.entry_id.clone(), name.clone())]
                            .value
                            .clone(),
                    );
                }
                PropertyKind::Rollup => {
                    let value = rollup_value(
                        &witness.entry_id,
                        name,
                        definitions,
                        &states,
                        &by_id,
                        &unavailable,
                        &relationships,
                        &result,
                        &mut BTreeSet::new(),
                        &mut budget,
                    )?;
                    if let BaseValue::Error { code, message } = &value {
                        issue(
                            &mut result.diagnostics,
                            record,
                            name,
                            code,
                            message,
                            &mut budget,
                        )?;
                    }
                    budget.keep(&value)?;
                    values.insert(name.clone(), value);
                }
                _ => {}
            }
        }
        if !values.is_empty() {
            budget.keep(&values)?;
            result
                .rows
                .entry(witness.entry_id.clone())
                .or_insert_with(|| PropertyRelationRow {
                    witness: witness.clone(),
                    values: BTreeMap::new(),
                })
                .values
                .extend(values);
        }
    }
    result.steps_used = budget.used;
    crate::encoded_size(&result, options.max_output_bytes)?;
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
fn rollup_value(
    entry: &EntryId,
    name: &str,
    definitions: &PropertyDefinitions,
    states: &BTreeMap<RelationKey, RelationState>,
    records: &HashMap<EntryId, &DetachedRecord>,
    unavailable: &BTreeSet<&EntryId>,
    relationships: &crate::graph::PreparedRelationships<'_>,
    scalars: &PropertyRelationValues,
    visiting: &mut BTreeSet<RelationKey>,
    budget: &mut Budget<'_>,
) -> Result<BaseValue, ExpressionDiagnostic> {
    budget.charge(1)?;
    let key = (entry.clone(), name.to_string());
    if visiting.len() >= 64 || !visiting.insert(key.clone()) {
        return Ok(error(
            "rollup_cycle",
            "Rollup dependency contains a cycle or exceeds depth 64",
        ));
    }
    let definition = definitions
        .get(name)
        .and_then(|d| d.rollup.as_ref())
        .expect("validated rollup");
    let state = &states[&(entry.clone(), definition.relation.clone())];
    if !state.valid {
        visiting.remove(&key);
        return Ok(error(
            "unavailable",
            "Rollup relation has invalid or unresolved targets",
        ));
    }
    if definition.aggregation == RollupAggregation::Count {
        visiting.remove(&key);
        return Ok(BaseValue::Number {
            value: state.targets.len() as f64,
        });
    }
    let property = definition.property.as_deref().expect("validated property");
    let mut values = Vec::new();
    for target in &state.targets {
        budget.charge(1)?;
        if unavailable.contains(target) {
            visiting.remove(&key);
            return Ok(error(
                "unavailable",
                "Related property metadata is unavailable",
            ));
        }
        let value = if definitions
            .get(property)
            .is_some_and(|d| d.kind == PropertyKind::Rollup)
        {
            rollup_value(
                target,
                property,
                definitions,
                states,
                records,
                unavailable,
                relationships,
                scalars,
                visiting,
                budget,
            )?
        } else if let Some(state) = states.get(&(target.clone(), property.to_string())) {
            state.value.clone()
        } else if let Some(value) = scalars
            .rows
            .get(target)
            .and_then(|row| row.values.get(property))
        {
            value.clone()
        } else {
            let expression = format!("note[{}]", serde_json::to_string(property).expect("string"));
            let invocation = budget.evaluation();
            let (value, used) = crate::with_session(
                &expression,
                records[target],
                &invocation,
                Some(relationships),
                |session| {
                    let value = session.evaluate(&expression);
                    Ok((value, session.steps_used()))
                },
            )?;
            budget.charge(used)?;
            match value {
                Ok(value) => value,
                Err(error) if matches!(error.code.as_str(), "budget" | "cancelled") => {
                    return Err(error)
                }
                Err(error) => BaseValue::Error {
                    code: error.code,
                    message: error.message,
                },
            }
        };
        budget.keep(&value)?;
        values.push(value);
    }
    visiting.remove(&key);
    aggregate(&definition.aggregation, values, budget)
}

fn aggregate(
    aggregation: &RollupAggregation,
    values: Vec<BaseValue>,
    budget: &mut Budget<'_>,
) -> Result<BaseValue, ExpressionDiagnostic> {
    if let Some(value) = values
        .iter()
        .find(|value| matches!(value, BaseValue::Error { .. }))
    {
        return Ok(value.clone());
    }
    Ok(match aggregation {
        RollupAggregation::Values => BaseValue::List { value: values },
        RollupAggregation::Unique => {
            let mut unique = Vec::new();
            let mut seen = BTreeSet::new();
            for value in values {
                budget.charge(1)?;
                let key = crate::query::canonical(&value);
                budget.charge(1 + key.len() / 64)?;
                if seen.insert(key) {
                    unique.push(value);
                }
            }
            BaseValue::List { value: unique }
        }
        RollupAggregation::Count => BaseValue::Number {
            value: values.len() as f64,
        },
        RollupAggregation::Min | RollupAggregation::Max
            if values
                .iter()
                .any(|value| matches!(value, BaseValue::Date { .. })) =>
        {
            let mut dates = Vec::new();
            for value in values {
                budget.charge(1)?;
                match value {
                    BaseValue::Null => {}
                    BaseValue::Date { .. } => dates.push(value),
                    _ => {
                        return Ok(error(
                            "rollup_type",
                            "Date min/max rollups require date related values",
                        ))
                    }
                }
            }
            dates
                .into_iter()
                .reduce(|left, right| {
                    let BaseValue::Date { timestamp: l, .. } = &left else {
                        unreachable!()
                    };
                    let BaseValue::Date { timestamp: r, .. } = &right else {
                        unreachable!()
                    };
                    if (*aggregation == RollupAggregation::Min && r < l)
                        || (*aggregation == RollupAggregation::Max && r > l)
                    {
                        right
                    } else {
                        left
                    }
                })
                .unwrap_or(BaseValue::Null)
        }
        _ => {
            let mut numbers = Vec::new();
            for value in values {
                budget.charge(1)?;
                match value {
                    BaseValue::Null => {},
                    BaseValue::Number { value } if value.is_finite() => numbers.push(value),
                    _ => return Ok(error("rollup_type", "Numeric rollups require numeric related values; source values are preserved")),
                }
            }
            if numbers.is_empty() {
                return Ok(if *aggregation == RollupAggregation::Sum {
                    BaseValue::Number { value: 0.0 }
                } else {
                    BaseValue::Null
                });
            }
            let value = match aggregation {
                RollupAggregation::Sum => numbers.iter().sum(),
                RollupAggregation::Average => numbers.iter().sum::<f64>() / numbers.len() as f64,
                RollupAggregation::Min => numbers.into_iter().fold(f64::INFINITY, f64::min),
                RollupAggregation::Max => numbers.into_iter().fold(f64::NEG_INFINITY, f64::max),
                _ => unreachable!(),
            };
            if value.is_finite() {
                BaseValue::Number { value }
            } else {
                error("numeric-domain", "Rollup result is not finite")
            }
        }
    })
}

impl BaseSnapshot {
    /// Attaches derived property values without mutating committed source rows.
    /// Prepared-cache callers must include these settings in their cache proof,
    /// or use the uncached generation entry point until such a proof exists.
    pub fn with_property_definitions(
        mut self,
        definitions: &PropertyDefinitions,
        options: &QueryOptions,
    ) -> Result<Self, ExpressionDiagnostic> {
        let values = query_property_relations(&self, definitions, options)?;
        self.property_values = Some(values);
        Ok(self)
    }
}
