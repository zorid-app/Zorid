//! Source membership is supplied only by a trusted host's retained authority
//! snapshot. Frontmatter `_type`, names and caller query JSON never grant it.
use crate::{BaseProgram, BaseQueryResult, BaseSnapshot, BaseViewSource, EntryId,
    ExpressionDiagnostic, FilePresentationFacts, PropertyType, PropertyValue, QueryOptions};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use zorid_index::Generation;

#[derive(Clone, Debug)]
pub struct BaseSourceScope {
    source: BaseViewSource,
    revision: String,
    assigned: BTreeSet<EntryId>,
    members: BTreeSet<EntryId>,
    values: BTreeMap<EntryId, Vec<(String, PropertyValue)>>,
    types: Vec<(String, PropertyType)>,
}
impl BaseSourceScope {
    /// In-process authority seam, deliberately not Deserialize. The host must
    /// capture this state with the generation's source manifest, not query live
    /// state after retaining an older document pin.
    pub fn captured(source: BaseViewSource, revision: String,
        memberships: &BTreeMap<EntryId, String>,
        values: BTreeMap<EntryId, Vec<(String, PropertyValue)>>,
        types: Vec<(String, PropertyType)>,
    ) -> Result<Self, ExpressionDiagnostic> {
        source.validate()?;
        if revision.is_empty() || revision.len() > 128 || memberships.len() > crate::MAX_QUERY_SCANNED
            || values.len() > crate::MAX_QUERY_SCANNED || types.len() > 1024 {
            return Err(ExpressionDiagnostic::new("budget", "Captured source state exceeds supported bounds"));
        }
        crate::encoded_size(&(&values, &types, memberships), crate::MAX_BASE_REQUEST_BYTES)?;
        let members = match &source {
            BaseViewSource::Untyped => {
                if !values.is_empty() || !types.is_empty() { return Err(ExpressionDiagnostic::new("source-mismatch", "Untyped sources cannot grant field definitions")); }
                BTreeSet::new()
            },
            BaseViewSource::Collection { id } => memberships.iter().filter_map(|(entry, owner)| (owner == id).then_some(entry.clone())).collect(),
        };
        if values.keys().any(|id| !members.contains(id)) {
            return Err(ExpressionDiagnostic::new("source-mismatch", "Values belong to a different source collection"));
        }
        let field_ids = types.iter().map(|(id, _)| id.as_str()).collect::<BTreeSet<_>>();
        if field_ids.len() != types.len() || field_ids.iter().any(|id| id.len() != 12 || !id.bytes().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase())) {
            return Err(ExpressionDiagnostic::new("source-mismatch", "Collection field identities are invalid or duplicated"));
        }
        for fields in values.values() {
            let keys = fields.iter().map(|(id, _)| id.as_str()).collect::<BTreeSet<_>>();
            if keys.len() != fields.len() || keys.iter().any(|id| !field_ids.contains(id)) {
                return Err(ExpressionDiagnostic::new("source-mismatch", "Captured values do not match their collection fields"));
            }
            for (_, value) in fields { value.validate_json_numbers().map_err(|message| ExpressionDiagnostic::new("input", message))?; }
        }
        Ok(Self { source, revision, assigned: memberships.keys().cloned().collect(), members, values, types })
    }
    pub fn source(&self) -> &BaseViewSource { &self.source }
    pub fn revision(&self) -> &str { &self.revision }
    pub(crate) fn includes(&self, id: &EntryId) -> bool {
        match self.source { BaseViewSource::Untyped => !self.assigned.contains(id), BaseViewSource::Collection { .. } => self.members.contains(id) }
    }
}

/// A fresh scoped answer. Optional answer/preparation caches do not yet include
/// structured-state revision in their proof and must not serve this path.
pub fn query_generation_scoped(program: &BaseProgram, generation: &Generation,
    facts: &[FilePresentationFacts], scope: BaseSourceScope, options: &QueryOptions,
) -> Result<BaseQueryResult, ExpressionDiagnostic> {
    crate::graph::preflight_generation(generation, options)?;
    if program.view_source(options.view_index) != Some(scope.source()) {
        return Err(ExpressionDiagnostic::new("source-mismatch", "Captured membership belongs to a different view source"));
    }
    let mut remaining = options.max_steps;
    let mut snapshot = BaseSnapshot::from_generation_checked(generation, facts, &mut |work| {
        if options.evaluation.cancellation.as_ref().is_some_and(|c| c.is_cancelled()) { return Err(ExpressionDiagnostic::new("cancelled", "Query cancelled")); }
        remaining = remaining.checked_sub(work).ok_or_else(|| ExpressionDiagnostic::new("budget", "Source preparation exceeds query work budget"))?;
        Ok(())
    })?;
    if matches!(scope.source, BaseViewSource::Collection { .. }) {
        for record in &mut snapshot.records {
            if let Some(witness) = record.witness.as_ref().filter(|w| scope.includes(&w.entry_id)) {
                let values = scope.values.get(&witness.entry_id).ok_or_else(|| ExpressionDiagnostic::new("source-unavailable", "A live collection member has no captured structured values"))?;
                record.properties = values.clone();
                record.property_types = scope.types.clone();
            }
        }
    }
    let used = options.max_steps - remaining;
    let mut selected = options.clone();
    selected.max_steps = remaining;
    selected.source_scope = Some(Arc::new(scope));
    let mut result = crate::query_base(program, &snapshot, &selected)?;
    result.steps_used = result.steps_used.saturating_add(used);
    crate::encoded_size(&result, options.max_output_bytes)?;
    Ok(result)
}
