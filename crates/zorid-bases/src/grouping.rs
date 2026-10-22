//! Bounded view grouping. Loose equality is deliberately a first-match relation,
//! not a hash equivalence: date-only values and singleton lists make it nontransitive.
use super::*;
use expression::{BasesTimezone, RuntimeValue};

pub(super) struct Context<'a, 's, 'g, 'p> {
    pub view: &'a program::View,
    pub options: &'a QueryOptions,
    pub timezone: &'a BasesTimezone,
    pub records: &'a HashMap<&'s crate::EntryId, &'s DetachedRecord>,
    pub paths: &'a HashMap<&'s str, &'s DetachedRecord>,
    pub graph: Option<&'a crate::graph::PreparedRelationships<'g>>,
    pub properties: Option<&'s crate::relations::PropertyRelationValues>,
    pub origin: Option<&'s DetachedRecord>,
    pub diagnostics: &'a mut Vec<QueryDiagnostic>,
    pub steps: &'a mut usize,
    pub admission: &'a mut Admission<'p>,
}
impl Context<'_, '_, '_, '_> {
    fn check(&mut self, work: usize) -> Result<(), ExpressionDiagnostic> {
        *self.steps = self.steps.saturating_add(work);
        if self
            .options
            .evaluation
            .cancellation
            .as_ref()
            .is_some_and(|c| c.is_cancelled())
        {
            return Err(ExpressionDiagnostic::new("cancelled", "Query cancelled"));
        }
        check_query_work(
            *self.steps,
            self.admission,
            self.options,
            "Grouping exceeds query work budget",
        )
    }
    fn reserve(&mut self, bytes: usize) -> Result<(), ExpressionDiagnostic> {
        admit(self.admission, |_| Ok(bytes))
    }
    fn value_copy(&mut self, value: &BaseValue) -> Result<(), ExpressionDiagnostic> {
        admit(self.admission, |admission| {
            crate::preview::value_bytes(value, admission)
        })
    }
    fn runtime(
        &mut self,
        value: &BaseValue,
        remaining_bytes: usize,
    ) -> Result<(RuntimeValue, usize), ExpressionDiagnostic> {
        let mut options = self.options.evaluation.clone();
        options.max_steps = options.max_steps.min(
            self.options
                .max_steps
                .saturating_sub(*self.steps)
                .saturating_sub(admission_work(self.admission)),
        );
        let timezone = self.timezone;
        let paths = self.paths;
        let mut file_work = 0usize;
        let mut file_bytes = 0usize;
        let admission = &mut self.admission;
        let (mut runtime, steps) =
            expression::group_runtime_from_base(value, timezone, &options, |path| {
                let record = paths.get(path).copied().ok_or_else(|| {
                    ExpressionDiagnostic::new(
                        "unavailable",
                        "Grouped File has no captured metadata",
                    )
                })?;
                let bytes = crate::encoded_size(record, crate::MAX_BASE_REQUEST_BYTES)?;
                file_work = file_work.saturating_add(bytes / 16 + 1);
                if file_work > options.max_steps {
                    return Err(ExpressionDiagnostic::new(
                        "budget",
                        "Grouped File metadata exceeds work budget",
                    ));
                }
                file_bytes = file_bytes.saturating_add(bytes.saturating_mul(24));
                if file_bytes > remaining_bytes {
                    return Err(ExpressionDiagnostic::new(
                        "budget",
                        "Grouped File metadata exceeds byte budget",
                    ));
                }
                admit(admission, |_| Ok(bytes.saturating_mul(24)))?;
                crate::runtime_file(record, timezone)
            })?;
        self.check(steps.saturating_add(file_work))?;
        // Link DTOs carry authority by exact witness, never by their displayed
        // spelling. Bind the path once before reusing expression equality.
        fn bind(
            value: &mut RuntimeValue,
            ctx: &mut Context<'_, '_, '_, '_>,
        ) -> Result<(), ExpressionDiagnostic> {
            ctx.check(1)?;
            match value {
                RuntimeValue::Link(link) => {
                    let path = link.target.as_ref().map(|witness| {
                        ctx.records
                            .get(&witness.entry_id)
                            .filter(|record| record.witness.as_ref() == Some(witness))
                            .map(|record| record.path.as_str())
                    });
                    if let Some(path) = path {
                        let path = path.ok_or_else(|| {
                            ExpressionDiagnostic::new(
                                "stale-source",
                                "Grouped Link has no exact captured revision",
                            )
                        })?;
                        ctx.check(path.len() / 16 + 1)?;
                        ctx.reserve(crate::preview::string_bytes(path))?;
                        link.resolved_path = Some(Some(path.to_string()));
                    } else {
                        link.resolved_path = Some(None);
                    }
                }
                RuntimeValue::List(values) => {
                    for value in values {
                        bind(value, ctx)?;
                    }
                }
                RuntimeValue::Object(values) => {
                    for value in values.values_mut() {
                        bind(value, ctx)?;
                    }
                }
                _ => {}
            }
            Ok(())
        }
        bind(&mut runtime, self)?;
        Ok((runtime, file_bytes))
    }
    fn matches(
        &mut self,
        key: &RuntimeValue,
        value: &RuntimeValue,
        manual: bool,
    ) -> Result<bool, ExpressionDiagnostic> {
        let timezone = self.timezone;
        expression::group_values_match(key, value, manual, timezone, &mut |work| self.check(work))
    }
    fn spelling(&mut self, value: &RuntimeValue) -> Result<String, ExpressionDiagnostic> {
        expression::group_value_string(value, &mut |work| self.check(work))
    }
    fn property_work(
        &mut self,
        record: Option<&DetachedRecord>,
    ) -> Result<(), ExpressionDiagnostic> {
        self.check(1)?;
        if let Some(record) = record {
            for (name, _) in &record.properties {
                self.check(name.len() + 1)?;
            }
            let properties = self.properties;
            if let Some(row) = record
                .witness
                .as_ref()
                .and_then(|w| properties.and_then(|p| p.rows().get(&w.entry_id)))
            {
                for name in row.values.keys() {
                    self.check(name.len() + 1)?;
                }
            }
        } else if let Some(properties) = self.properties {
            for name in properties.property_names() {
                self.check(name.len() + 1)?;
            }
        }
        Ok(())
    }
}
struct RowKey {
    value: BaseValue,
    raw: BaseValue,
    runtime: RuntimeValue,
    writable: bool,
}
struct Slot {
    key: BaseValue,
    source: BaseValue,
    runtime: RuntimeValue,
    id: String,
}
#[derive(Default)]
struct Plan {
    slot: Option<usize>,
    representative: Option<crate::EntryId>,
    entries: Vec<crate::EntryId>,
}
pub(super) struct Engine {
    rows: HashMap<crate::EntryId, RowKey>,
    slots: Option<Vec<Slot>>,
    assignments: HashMap<crate::EntryId, Option<usize>>,
    memory: usize,
}
impl Engine {
    fn reserve(
        &mut self,
        ctx: &mut Context<'_, '_, '_, '_>,
        bytes: usize,
    ) -> Result<(), ExpressionDiagnostic> {
        self.memory = self.memory.saturating_add(bytes);
        if self.memory > crate::MAX_BASE_REQUEST_BYTES {
            return Err(ExpressionDiagnostic::new(
                "budget",
                "Grouping keys exceed byte budget",
            ));
        }
        ctx.reserve(bytes)
    }
    pub(super) fn prepare(
        rows: &[BaseRow],
        ctx: &mut Context<'_, '_, '_, '_>,
    ) -> Result<Self, ExpressionDiagnostic> {
        let mut result = Self {
            rows: HashMap::new(),
            slots: None,
            assignments: HashMap::new(),
            memory: 0,
        };
        let view = ctx.view;
        let property = &view.group.as_ref().expect("grouping selected").property;
        for row in rows {
            ctx.check(1)?;
            let value = row.values.get(property).unwrap_or(&BaseValue::Null);
            let record = ctx.records[&row.entry_id];
            ctx.property_work(Some(record))?;
            let writable = property
                .strip_prefix("note.")
                .is_some_and(|name| !readonly_note_property(record, ctx.properties, name));
            let raw = row.edit_values.get(property).unwrap_or(value);
            let bytes = crate::encoded_size(&(value, raw), crate::MAX_BASE_REQUEST_BYTES)?;
            result.reserve(
                ctx,
                bytes
                    .saturating_mul(24)
                    .saturating_add(map_slot::<crate::EntryId, RowKey>()),
            )?;
            let (runtime, file_bytes) = ctx.runtime(
                value,
                crate::MAX_BASE_REQUEST_BYTES.saturating_sub(result.memory),
            )?;
            result.memory = result.memory.saturating_add(file_bytes);
            result.rows.insert(
                row.entry_id.clone(),
                RowKey {
                    value: value.clone(),
                    raw: raw.clone(),
                    runtime,
                    writable,
                },
            );
        }
        if let Some(configured) = &view.group_order {
            if configured.len() > ctx.options.max_groups {
                return Err(ExpressionDiagnostic::new(
                    "budget",
                    "Configured groups exceed group budget",
                ));
            }
            let mut configured_slots = Vec::new();
            for (ordinal, source) in configured.iter().enumerate() {
                let bytes = crate::encoded_size(source, crate::MAX_BASE_REQUEST_BYTES)?;
                result.reserve(
                    ctx,
                    bytes.saturating_mul(32).saturating_add(slots::<Slot>(1)),
                )?;
                let mut work = 0usize;
                let remaining = ctx
                    .options
                    .max_steps
                    .saturating_sub(*ctx.steps)
                    .saturating_sub(admission_work(ctx.admission));
                let cancellation = ctx.options.evaluation.cancellation.as_ref();
                let key = hydrate_group_order_key(
                    source,
                    property,
                    ctx.origin,
                    ctx.graph,
                    ctx.timezone,
                    &mut |used| {
                        work = work.saturating_add(used);
                        if cancellation.is_some_and(|c| c.is_cancelled()) {
                            return Err(ExpressionDiagnostic::new("cancelled", "Query cancelled"));
                        }
                        if work > remaining {
                            return Err(ExpressionDiagnostic::new(
                                "budget",
                                "Group order hydration exceeds work budget",
                            ));
                        }
                        Ok(())
                    },
                    &mut |bytes| admit(ctx.admission, |_| Ok(bytes)),
                )?;
                ctx.check(work)?;
                let (runtime, file_bytes) = ctx.runtime(
                    &key,
                    crate::MAX_BASE_REQUEST_BYTES.saturating_sub(result.memory),
                )?;
                result.memory = result.memory.saturating_add(file_bytes);
                canonical_admission(source, ctx.admission)?;
                let id = format!("base-key-v2:manual:{ordinal}:{}", canonical(source));
                result.reserve(ctx, crate::preview::string_bytes(&id))?;
                configured_slots.push(Slot {
                    key,
                    source: source.clone(),
                    runtime,
                    id,
                });
            }
            result.slots = Some(configured_slots);
            for row in rows {
                let mut assignment = None;
                for (index, slot) in result
                    .slots
                    .as_ref()
                    .expect("slots created")
                    .iter()
                    .enumerate()
                {
                    let row_key = &result.rows[&row.entry_id];
                    let raw_text_match =
                        if let (BaseValue::String { value: source }, BaseValue::String { value }) =
                            (&slot.source, &row_key.value)
                        {
                            ctx.check(source.len().saturating_add(value.len()) / 16 + 1)?;
                            source == value
                        } else {
                            false
                        };
                    if raw_text_match || ctx.matches(&slot.runtime, &row_key.runtime, true)? {
                        assignment = Some(index);
                        break;
                    }
                }
                result.reserve(ctx, map_slot::<crate::EntryId, Option<usize>>())?;
                result.assignments.insert(row.entry_id.clone(), assignment);
            }
        }
        Ok(result)
    }
    pub(super) fn admits(&self, row: &BaseRow) -> bool {
        self.slots.is_none()
            || self
                .assignments
                .get(&row.entry_id)
                .is_some_and(Option::is_some)
    }
    fn append(
        &self,
        plan: &mut Plan,
        id: &crate::EntryId,
        ctx: &mut Context<'_, '_, '_, '_>,
    ) -> Result<(), ExpressionDiagnostic> {
        ctx.check(1)?;
        ctx.reserve(
            slots::<crate::EntryId>(1).saturating_add(crate::preview::string_bytes(id.as_str())),
        )?;
        if plan.representative.is_none() {
            plan.representative = Some(id.clone());
        }
        plan.entries.push(id.clone());
        Ok(())
    }
    fn automatic<'a>(
        &self,
        ids: impl IntoIterator<Item = &'a crate::EntryId>,
        ctx: &mut Context<'_, '_, '_, '_>,
    ) -> Result<Vec<Plan>, ExpressionDiagnostic> {
        let mut plans: Vec<Plan> = Vec::new();
        let mut buckets: HashMap<String, Vec<usize>> = HashMap::new();
        for id in ids {
            let runtime = &self.rows[id].runtime;
            let spelling = ctx.spelling(runtime)?;
            ctx.reserve(
                crate::preview::string_bytes(&spelling)
                    .saturating_add(map_slot::<String, Vec<usize>>()),
            )?;
            let mut found = None;
            if let Some(indices) = buckets.get(&spelling) {
                for index in indices {
                    let representative = plans[*index]
                        .representative
                        .as_ref()
                        .expect("nonempty automatic group");
                    if ctx.matches(&self.rows[representative].runtime, runtime, false)? {
                        found = Some(*index);
                        break;
                    }
                }
            }
            if found.is_none() {
                for (index, plan) in plans.iter().enumerate() {
                    let representative = plan
                        .representative
                        .as_ref()
                        .expect("nonempty automatic group");
                    if ctx.matches(&self.rows[representative].runtime, runtime, false)? {
                        found = Some(index);
                        break;
                    }
                }
            }
            let index = if let Some(index) = found {
                index
            } else {
                if plans.len() >= ctx.options.max_groups {
                    return Err(ExpressionDiagnostic::new(
                        "budget",
                        "Query exceeds group budget",
                    ));
                }
                ctx.reserve(slots::<Plan>(1))?;
                plans.push(Plan::default());
                plans.len() - 1
            };
            let bucket = buckets.entry(spelling).or_default();
            ctx.check(bucket.len() + 1)?;
            if !bucket.contains(&index) {
                ctx.reserve(slots::<usize>(1))?;
                bucket.push(index);
            }
            self.append(&mut plans[index], id, ctx)?;
        }
        Ok(plans)
    }
    fn manual(
        &self,
        rows: &[BaseRow],
        ctx: &mut Context<'_, '_, '_, '_>,
    ) -> Result<Vec<Plan>, ExpressionDiagnostic> {
        let slots = self.slots.as_ref().expect("manual grouping");
        ctx.reserve(super::slots::<Plan>(slots.len()))?;
        let mut plans = slots
            .iter()
            .enumerate()
            .map(|(index, _)| Plan {
                slot: Some(index),
                ..Default::default()
            })
            .collect::<Vec<_>>();
        for row in rows {
            if let Some(Some(index)) = self.assignments.get(&row.entry_id) {
                self.append(&mut plans[*index], &row.entry_id, ctx)?;
            }
        }
        Ok(plans)
    }
    fn metadata(
        &self,
        plan: &Plan,
        ctx: &mut Context<'_, '_, '_, '_>,
    ) -> Result<(String, BaseValue, Option<BaseValue>, Option<BaseValue>), ExpressionDiagnostic>
    {
        let slot = plan
            .slot
            .map(|index| &self.slots.as_ref().expect("manual slot")[index]);
        let row = plan.representative.as_ref().map(|id| &self.rows[id]);
        let key = row
            .map(|row| &row.value)
            .unwrap_or_else(|| &slot.expect("empty group is configured").key);
        let raw = row
            .map(|row| &row.raw)
            .unwrap_or_else(|| &slot.expect("empty group is configured").source);
        canonical_admission(key, ctx.admission)?;
        let id = slot.map_or_else(|| group_key_id(key), |slot| slot.id.clone());
        ctx.reserve(crate::preview::string_bytes(&id))?;
        ctx.value_copy(key)?;
        let view = ctx.view;
        let property = &view.group.as_ref().expect("group selected").property;
        ctx.property_work(None)?;
        let mut writable = property
            .strip_prefix("note.")
            .is_some_and(|name| !readonly_empty_group_property(ctx.properties, name));
        if !plan.entries.is_empty() {
            writable = property.starts_with("note.");
            for id in &plan.entries {
                ctx.check(1)?;
                writable &= self.rows[id].writable;
            }
        }
        let mut work = 0usize;
        let remaining = ctx
            .options
            .max_steps
            .saturating_sub(*ctx.steps)
            .saturating_sub(admission_work(ctx.admission));
        let cancellation = ctx.options.evaluation.cancellation.as_ref();
        let mut check = |used: usize| {
            work = work.saturating_add(used);
            if cancellation.is_some_and(|c| c.is_cancelled()) {
                return Err(ExpressionDiagnostic::new("cancelled", "Query cancelled"));
            }
            if work > remaining {
                return Err(ExpressionDiagnostic::new(
                    "budget",
                    "Group serialization exceeds work budget",
                ));
            }
            Ok(())
        };
        let edit = if writable {
            transfer_group_edit_key(key, raw, ctx.records, ctx.graph, &mut check)
        } else {
            Ok(None)
        };
        let order =
            serialize_group_order_key(key, raw, ctx.records, ctx.graph, ctx.timezone, &mut check);
        ctx.check(work)?;
        let mut accept=|value:Result<Option<BaseValue>,ExpressionDiagnostic>|->Result<Option<BaseValue>,ExpressionDiagnostic>{match value{
            Ok(value)=>Ok(value),Err(error)if fatal(&error)=>Err(error),Err(error)=>{
                if let Some(record)=plan.representative.as_ref().map(|id|ctx.records[id]).or(ctx.origin){report(ctx.diagnostics,record,"group",Some(property),error,ctx.admission)?;}Ok(None)
            }
        }};
        let edit = accept(edit)?;
        let order = accept(order)?;
        for value in edit.iter().chain(order.iter()) {
            ctx.value_copy(value)?;
        }
        Ok((id, key.clone(), edit, order))
    }
    pub(super) fn options(
        &self,
        rows: &[BaseRow],
        ctx: &mut Context<'_, '_, '_, '_>,
    ) -> Result<Vec<GroupOption>, ExpressionDiagnostic> {
        let (mut plans, listed) = if self.slots.is_some() {
            let plans = self.manual(rows, ctx)?;
            let count = plans.len();
            (plans, count)
        } else {
            let plans = self.automatic(rows.iter().map(|row| &row.entry_id), ctx)?;
            let count = plans.len();
            (plans, count)
        };
        if self.slots.is_some() {
            plans.extend(
                self.automatic(
                    rows.iter()
                        .filter(|row| !self.admits(row))
                        .map(|row| &row.entry_id),
                    ctx,
                )?,
            );
        }
        if plans.len() > ctx.options.max_groups {
            return Err(ExpressionDiagnostic::new(
                "budget",
                "Query exceeds group-option budget",
            ));
        }
        ctx.reserve(slots::<GroupOption>(plans.len()))?;
        let mut result = Vec::new();
        for (index, plan) in plans.iter().enumerate() {
            let (key_id, key, edit_key, order_key) = self.metadata(plan, ctx)?;
            result.push(GroupOption {
                key_id,
                key,
                edit_key,
                order_key,
                count: plan.entries.len(),
                listed: index < listed,
            });
        }
        Ok(result)
    }
    pub(super) fn display(
        &self,
        rows: &[BaseRow],
        ctx: &mut Context<'_, '_, '_, '_>,
    ) -> Result<Vec<BaseGroup>, ExpressionDiagnostic> {
        let mut plans = if self.slots.is_some() {
            self.manual(rows, ctx)?
        } else {
            self.automatic(rows.iter().map(|row| &row.entry_id), ctx)?
        };
        let kanban =
            program::get(&ctx.view.configuration, "type").and_then(program::text) == Some("kanban");
        if self.slots.is_some() && !kanban {
            plans.retain(|plan| !plan.entries.is_empty());
        }
        ctx.reserve(slots::<BaseGroup>(plans.len()))?;
        let mut result = Vec::new();
        let mut ids = HashSet::new();
        for plan in plans {
            let (mut id, key, edit_key, order_key) = self.metadata(&plan, ctx)?;
            // Canonical IDs identify representatives, not loose equivalence.
            // A collision between unequal runtime keys must still yield a
            // distinct opaque column identity in this invocation.
            if !ids.insert(id.clone()) {
                id = format!("{id}:slot:{}", result.len());
                ids.insert(id.clone());
            }
            let spelling = if self.slots.is_none() {
                ctx.spelling(
                    &self.rows[plan
                        .representative
                        .as_ref()
                        .expect("automatic group representative")]
                    .runtime,
                )?
            } else {
                String::new()
            };
            result.push((
                BaseGroup {
                    key_id: Some(id),
                    key: Some(key),
                    edit_key,
                    order_key,
                    entry_ids: plan.entries,
                    summaries: BTreeMap::new(),
                },
                spelling,
            ));
        }
        if self.slots.is_none() {
            comparator_scratch_admission(
                result.iter().filter_map(|(group, _)| group.key.as_ref()),
                ctx.admission,
            )?;
            let comparisons = result
                .len()
                .saturating_mul(result.len().max(2).ilog2() as usize + 1);
            let longest = result.iter().map(|(_, text)| text.len()).max().unwrap_or(0);
            ctx.check(comparisons.saturating_mul(longest / 16 + 1))?;
            let descending = ctx.view.group.as_ref().expect("group").descending;
            // FJ compares two numbers numerically and all other populated
            // group keys by their typed tostring. Group direction is applied
            // only after the final rows selected their representatives.
            result.sort_by(|(a, a_text), (b, b_text)| {
                let a = a.key.as_ref().unwrap();
                let b = b.key.as_ref().unwrap();
                let a_empty = matches!(a, BaseValue::Null | BaseValue::Error { .. });
                let b_empty = matches!(b, BaseValue::Null | BaseValue::Error { .. });
                if a_empty || b_empty {
                    return a_empty.cmp(&b_empty);
                }
                let comparison = if let (
                    BaseValue::Number { value: a },
                    BaseValue::Number { value: b },
                ) = (a, b)
                {
                    a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)
                } else {
                    order::natural_text(a_text, b_text)
                };
                if descending {
                    comparison.reverse()
                } else {
                    comparison
                }
            });
        }
        Ok(result.into_iter().map(|(group, _)| group).collect())
    }
}
