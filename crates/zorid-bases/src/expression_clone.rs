//! Private, admitted copies of actual runtime values. Plans borrow their exact
//! input, so materialization cannot substitute a larger or differently typed
//! value after admission. No resolution or metadata authority is added here.
//!
//! String, Vec and map heaps use fallible exact reservations. The fixed-size
//! File/display boxes are admitted before Box::new; stable safe Rust has no
//! fallible Box constructor. OOM for those fixed-size boxes follows the normal
//! process allocator policy, without adding an unsafe allocation path.
use super::{BasesFile, BasesLink, RuntimeValue};
use crate::{EntryId, RecordWitness, Revision, MAX_BASE_REQUEST_BYTES};
use indexmap::IndexMap;
use std::mem::{align_of, size_of};
use std::sync::Arc;

type Check<'a> = &'a mut dyn FnMut(usize) -> Result<(), RuntimeValue>;

fn budget(message: &str) -> RuntimeValue {
    RuntimeValue::Error(format!("budget\0{message}"))
}
fn sum(left: usize, right: usize) -> Result<usize, RuntimeValue> {
    left.checked_add(right)
        .filter(|value| *value <= MAX_BASE_REQUEST_BYTES)
        .ok_or_else(|| budget("Runtime clone exceeds byte allowance"))
}
fn product(left: usize, right: usize) -> Result<usize, RuntimeValue> {
    left.checked_mul(right)
        .filter(|value| *value <= MAX_BASE_REQUEST_BYTES)
        .ok_or_else(|| budget("Runtime clone allocation size overflow"))
}

/// Whole-map upper bound for a FRESH IndexMap, populated after ONE successful
/// try_reserve_exact(len). This never describes a clone of an existing table.
///
/// Pinned indexmap2.14.2 reserves the entry Vec exactly and asks hashbrown0.17.1
/// for a fresh usize index table. Twice len rounded up to a power of two (at
/// least16) dominates its87.5% load rule and small-table minimum. Each bucket
/// pays its usize index, control byte and generous control/alignment padding.
/// Entry layout includes all fields plus worst inter-field/tail alignment.
/// Existing source capacity, including hidden failed-reserve capacity, is
/// deliberately irrelevant. Allocator bookkeeping/usable-size rounding is not
/// a retained Rust allocation and is outside this requested-layout bound.
pub(super) fn fresh_map_allocation_bound<K, V>(len: usize) -> Result<usize, RuntimeValue> {
    let inline = size_of::<IndexMap<K, V>>();
    if len == 0 {
        return Ok(inline);
    }
    let buckets = len
        .checked_mul(2)
        .and_then(|value| value.max(16).checked_next_power_of_two())
        .ok_or_else(|| budget("Runtime clone map capacity overflow"))?;
    let alignment = align_of::<K>()
        .max(align_of::<V>())
        .max(align_of::<usize>());
    let entry = size_of::<K>()
        .checked_add(size_of::<V>())
        .and_then(|value| value.checked_add(size_of::<usize>()))
        .and_then(|value| value.checked_add(alignment.saturating_sub(1).saturating_mul(3)))
        .ok_or_else(|| budget("Runtime clone map entry layout overflow"))?;
    let entries = product(len, entry)?;
    let indices = sum(product(buckets, size_of::<usize>() + 1)?, 64)?;
    sum(sum(inline, entries)?, indices)
}
pub(super) fn object_map_allocation_bound(len: usize) -> Result<usize, RuntimeValue> {
    fresh_map_allocation_bound::<String, RuntimeValue>(len)
}

/// An immutable same-input proof. Metadata contains no allocation or owned
/// copy; the byte total includes the root RuntimeValue slot and all fresh heaps.
pub(super) struct ClonePlan<'a> {
    source: &'a RuntimeValue,
    allocation_bytes: usize,
}
impl ClonePlan<'_> {
    pub(super) fn allocation_bytes(&self) -> usize {
        self.allocation_bytes
    }
    pub(super) fn materialize(
        self,
        remaining_bytes: usize,
        check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
    ) -> Result<RuntimeValue, RuntimeValue> {
        check(0)?;
        if self.allocation_bytes > remaining_bytes {
            return Err(budget("Runtime clone exceeds remaining byte allowance"));
        }
        copy_value(self.source, 0, check)
    }
}

pub(super) fn prepare_clone<'a>(
    value: &'a RuntimeValue,
    check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
) -> Result<ClonePlan<'a>, RuntimeValue> {
    let mut planning = Planning {
        bytes: size_of::<RuntimeValue>(),
        check,
    };
    planning.value(value, 0)?;
    Ok(ClonePlan {
        source: value,
        allocation_bytes: planning.bytes,
    })
}

struct Planning<'a> {
    bytes: usize,
    check: Check<'a>,
}
impl Planning<'_> {
    fn add(&mut self, bytes: usize) -> Result<(), RuntimeValue> {
        self.bytes = sum(self.bytes, bytes)?;
        Ok(())
    }
    fn node(&mut self, depth: usize) -> Result<(), RuntimeValue> {
        (self.check)(1)?;
        if depth > 128 {
            return Err(budget("Runtime clone exceeds depth128"));
        }
        Ok(())
    }
    fn string(&mut self, value: &str) -> Result<(), RuntimeValue> {
        (self.check)(1 + value.len() / 16)?;
        self.add(value.len())
    }
    fn optional_string(&mut self, value: &Option<String>) -> Result<(), RuntimeValue> {
        if let Some(value) = value {
            self.string(value)?;
        }
        Ok(())
    }
    fn witness(&mut self, value: &Option<RecordWitness>) -> Result<(), RuntimeValue> {
        if let Some(value) = value {
            self.string(value.entry_id.as_str())?;
            self.string(value.revision.as_str())?;
        }
        Ok(())
    }
    fn object(
        &mut self,
        value: &IndexMap<String, RuntimeValue>,
        depth: usize,
    ) -> Result<(), RuntimeValue> {
        self.add(object_map_allocation_bound(value.len())?)?;
        for (key, value) in value {
            self.string(key)?;
            self.value(value, depth + 1)?;
        }
        Ok(())
    }
    fn link(&mut self, value: &BasesLink, depth: usize) -> Result<(), RuntimeValue> {
        self.node(depth)?;
        self.optional_string(&value.raw_destination)?;
        self.optional_string(&value.source_path)?;
        self.optional_string(&value.subpath)?;
        self.witness(&value.target)?;
        self.string(&value.path)?;
        self.optional_string(&value.display)?;
        if let Some(display) = &value.display_value {
            self.add(size_of::<RuntimeValue>())?;
            self.value(display, depth + 1)?;
        }
        if let Some(Some(path)) = &value.resolved_path {
            self.string(path)?;
        }
        Ok(())
    }
    fn file(&mut self, value: &BasesFile, depth: usize) -> Result<(), RuntimeValue> {
        self.add(size_of::<BasesFile>())?;
        self.witness(&value.witness)?;
        for field in [
            &value.path,
            &value.name,
            &value.basename,
            &value.folder,
            &value.extension,
        ] {
            self.string(field)?;
        }
        self.object(&value.properties, depth)?;
        self.add(product(value.tags.len(), size_of::<String>())?)?;
        for tag in &value.tags {
            self.string(tag)?;
        }
        for links in [&value.links, &value.embeds, &value.backlinks] {
            self.add(product(links.len(), size_of::<BasesLink>())?)?;
            for link in links {
                self.link(link, depth + 1)?;
            }
        }
        self.optional_string(&value.ctime)?;
        self.optional_string(&value.mtime)
    }
    fn value(&mut self, value: &RuntimeValue, depth: usize) -> Result<(), RuntimeValue> {
        self.node(depth)?;
        match value {
            RuntimeValue::String(value)
            | RuntimeValue::Tag(value)
            | RuntimeValue::Html(value)
            | RuntimeValue::Image(value)
            | RuntimeValue::Icon(value)
            | RuntimeValue::Error(value)
            | RuntimeValue::ErrorValue(value) => self.string(value),
            RuntimeValue::List(values) | RuntimeValue::TagList(values) => {
                self.add(product(values.len(), size_of::<RuntimeValue>())?)?;
                for value in values {
                    self.value(value, depth + 1)?;
                }
                Ok(())
            }
            RuntimeValue::Object(value) => self.object(value, depth),
            RuntimeValue::File(value) => self.file(value, depth),
            RuntimeValue::Link(value) => self.link(value, depth),
            RuntimeValue::Regex(pattern, flags, _) => {
                self.string(pattern)?;
                self.string(flags)
            }
            RuntimeValue::Null
            | RuntimeValue::Bool(_)
            | RuntimeValue::Number(_)
            | RuntimeValue::Date(_)
            | RuntimeValue::Duration(_) => Ok(()),
        }
    }
}

fn reserve_error(_: impl std::fmt::Display) -> RuntimeValue {
    budget("Runtime clone allocation reservation failed")
}
fn copy_string(value: &str, check: Check<'_>) -> Result<String, RuntimeValue> {
    check(1 + value.len() / 16)?;
    let mut result = String::new();
    result
        .try_reserve_exact(value.len())
        .map_err(reserve_error)?;
    result.push_str(value);
    Ok(result)
}
fn copy_optional_string(
    value: &Option<String>,
    check: Check<'_>,
) -> Result<Option<String>, RuntimeValue> {
    value
        .as_deref()
        .map(|value| copy_string(value, check))
        .transpose()
}
fn copy_witness(
    value: &Option<RecordWitness>,
    check: Check<'_>,
) -> Result<Option<RecordWitness>, RuntimeValue> {
    value
        .as_ref()
        .map(|value| {
            Ok(RecordWitness {
                entry_id: EntryId::new(copy_string(value.entry_id.as_str(), check)?)
                    .map_err(|_| budget("Captured clone witness is invalid"))?,
                revision: Revision::new(copy_string(value.revision.as_str(), check)?)
                    .map_err(|_| budget("Captured clone revision is invalid"))?,
            })
        })
        .transpose()
}
fn copy_object(
    value: &IndexMap<String, RuntimeValue>,
    depth: usize,
    check: Check<'_>,
) -> Result<IndexMap<String, RuntimeValue>, RuntimeValue> {
    // Fresh table initialization touches control/index storage. Charge the
    // container before reserve, in addition to the subsequent copied entries.
    check(1usize.saturating_add(value.len().saturating_mul(4)))?;
    let mut result = IndexMap::new();
    result
        .try_reserve_exact(value.len())
        .map_err(reserve_error)?;
    for (key, value) in value {
        let key = copy_string(key, check)?;
        let value = copy_value(value, depth + 1, check)?;
        result.insert(key, value);
    }
    Ok(result)
}
fn copy_link(value: &BasesLink, depth: usize, check: Check<'_>) -> Result<BasesLink, RuntimeValue> {
    check_depth(depth, check)?;
    Ok(BasesLink {
        raw_destination: copy_optional_string(&value.raw_destination, check)?,
        source_path: copy_optional_string(&value.source_path, check)?,
        subpath: copy_optional_string(&value.subpath, check)?,
        target: copy_witness(&value.target, check)?,
        path: copy_string(&value.path, check)?,
        display: copy_optional_string(&value.display, check)?,
        display_value: value
            .display_value
            .as_deref()
            .map(|value| copy_value(value, depth + 1, check).map(Box::new))
            .transpose()?,
        resolved_path: value
            .resolved_path
            .as_ref()
            .map(|path| copy_optional_string(path, check))
            .transpose()?,
        external: value.external,
    })
}
fn copy_file(value: &BasesFile, depth: usize, check: Check<'_>) -> Result<BasesFile, RuntimeValue> {
    let witness = copy_witness(&value.witness, check)?;
    let path = copy_string(&value.path, check)?;
    let name = copy_string(&value.name, check)?;
    let basename = copy_string(&value.basename, check)?;
    let folder = copy_string(&value.folder, check)?;
    let extension = copy_string(&value.extension, check)?;
    let properties = copy_object(&value.properties, depth, check)?;
    let mut tags = Vec::new();
    check(value.tags.len())?;
    tags.try_reserve_exact(value.tags.len())
        .map_err(reserve_error)?;
    for tag in &value.tags {
        tags.push(copy_string(tag, check)?);
    }
    let links = links_fn(&value.links, depth, check)?;
    let embeds = links_fn(&value.embeds, depth, check)?;
    let backlinks = links_fn(&value.backlinks, depth, check)?;
    Ok(BasesFile {
        witness,
        metadata_unavailable: value.metadata_unavailable,
        path,
        name,
        basename,
        folder,
        extension,
        size: value.size,
        properties,
        tags,
        links,
        embeds,
        backlinks,
        ctime: copy_optional_string(&value.ctime, check)?,
        mtime: copy_optional_string(&value.mtime, check)?,
    })
}
fn links_fn(
    values: &[BasesLink],
    depth: usize,
    check: Check<'_>,
) -> Result<Vec<BasesLink>, RuntimeValue> {
    check(values.len())?;
    let mut result = Vec::new();
    result
        .try_reserve_exact(values.len())
        .map_err(reserve_error)?;
    for value in values {
        result.push(copy_link(value, depth + 1, check)?);
    }
    Ok(result)
}
fn check_depth(depth: usize, check: Check<'_>) -> Result<(), RuntimeValue> {
    check(1)?;
    if depth > 128 {
        return Err(budget("Runtime clone exceeds depth128"));
    }
    Ok(())
}
fn copy_value(
    value: &RuntimeValue,
    depth: usize,
    check: Check<'_>,
) -> Result<RuntimeValue, RuntimeValue> {
    check_depth(depth, check)?;
    Ok(match value {
        RuntimeValue::Null => RuntimeValue::Null,
        RuntimeValue::Bool(value) => RuntimeValue::Bool(*value),
        RuntimeValue::Number(value) => RuntimeValue::Number(*value),
        RuntimeValue::String(value) => RuntimeValue::String(copy_string(value, check)?),
        RuntimeValue::Tag(value) => RuntimeValue::Tag(copy_string(value, check)?),
        RuntimeValue::Html(value) => RuntimeValue::Html(copy_string(value, check)?),
        RuntimeValue::Image(value) => RuntimeValue::Image(copy_string(value, check)?),
        RuntimeValue::Icon(value) => RuntimeValue::Icon(copy_string(value, check)?),
        RuntimeValue::Error(value) => RuntimeValue::Error(copy_string(value, check)?),
        RuntimeValue::ErrorValue(value) => RuntimeValue::ErrorValue(copy_string(value, check)?),
        RuntimeValue::Date(value) => RuntimeValue::Date(value.clone()),
        RuntimeValue::Duration(value) => RuntimeValue::Duration(value.clone()),
        RuntimeValue::List(values) | RuntimeValue::TagList(values) => {
            check(values.len())?;
            let mut result = Vec::new();
            result
                .try_reserve_exact(values.len())
                .map_err(reserve_error)?;
            for value in values {
                result.push(copy_value(value, depth + 1, check)?);
            }
            if matches!(value, RuntimeValue::TagList(_)) {
                RuntimeValue::TagList(result)
            } else {
                RuntimeValue::List(result)
            }
        }
        RuntimeValue::Object(value) => RuntimeValue::Object(copy_object(value, depth, check)?),
        RuntimeValue::File(value) => RuntimeValue::File(Box::new(copy_file(value, depth, check)?)),
        RuntimeValue::Link(value) => RuntimeValue::Link(copy_link(value, depth, check)?),
        RuntimeValue::Regex(pattern, flags, identity) => RuntimeValue::Regex(
            copy_string(pattern, check)?,
            copy_string(flags, check)?,
            Arc::clone(identity),
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::super::{BasesTimezone, DateValue, DurationValue};
    use super::*;

    fn error(value: RuntimeValue, code: &str) {
        assert!(
            matches!(value, RuntimeValue::Error(message) if message.starts_with(&format!("{code}\0")))
        );
    }
    fn witness() -> RecordWitness {
        RecordWitness {
            entry_id: EntryId::new("captured-entry").unwrap(),
            revision: Revision::new("r1").unwrap(),
        }
    }
    fn copy(source: &RuntimeValue) -> RuntimeValue {
        let plan = prepare_clone(source, &mut |_| Ok(())).unwrap();
        let bound = plan.allocation_bytes();
        plan.materialize(bound, &mut |_| Ok(())).unwrap()
    }

    #[test]
    fn fresh_rebuild_does_not_copy_oversized_string_vector_or_hidden_map_capacity() {
        let mut text = String::with_capacity(1024 * 1024);
        text.push_str("kept");
        let mut map = IndexMap::with_capacity(4096);
        map.insert("value".into(), RuntimeValue::String(text));
        let source_capacity = map.capacity();
        let mut list = Vec::with_capacity(4096);
        list.push(RuntimeValue::Object(map));
        let source = RuntimeValue::List(list);
        let plan = prepare_clone(&source, &mut |_| Ok(())).unwrap();
        assert!(plan.allocation_bytes() < 16 * 1024);
        let result = plan.materialize(16 * 1024, &mut |_| Ok(())).unwrap();
        let RuntimeValue::List(values) = result else {
            panic!("list subtype")
        };
        assert!(values.capacity() < 16);
        let RuntimeValue::Object(map) = &values[0] else {
            panic!("object subtype")
        };
        assert!(map.capacity() < source_capacity);
        assert!(map.capacity() < 16);
        let RuntimeValue::String(text) = &map["value"] else {
            panic!("string subtype")
        };
        assert_eq!(text, "kept");
        assert!(text.capacity() < 16);
    }

    #[test]
    fn copies_every_file_link_field_and_nested_subclass_without_minting_authority() {
        let identity = Arc::new(());
        let mut properties = IndexMap::new();
        properties.insert(
            "date".into(),
            RuntimeValue::Date(DateValue {
                millis: 1234,
                date_only: false,
                timezone: BasesTimezone::Utc,
            }),
        );
        properties.insert(
            "duration".into(),
            RuntimeValue::Duration(DurationValue {
                months: -2.5,
                milliseconds: -0.0,
                ..Default::default()
            }),
        );
        properties.insert(
            "tags".into(),
            RuntimeValue::TagList(vec![
                RuntimeValue::Tag("##Work/Child".into()),
                RuntimeValue::ErrorValue("type\0data".into()),
            ]),
        );
        properties.insert(
            "regex".into(),
            RuntimeValue::Regex("^x".into(), "i".into(), Arc::clone(&identity)),
        );
        properties.insert("html".into(), RuntimeValue::Html("<b>x</b>".into()));
        properties.insert("image".into(), RuntimeValue::Image("image.png".into()));
        properties.insert(
            "error".into(),
            RuntimeValue::Error("unavailable\0original".into()),
        );
        let link = BasesLink {
            raw_destination: Some("../Target#Heading".into()),
            source_path: Some("One/Note.md".into()),
            subpath: Some("#Heading".into()),
            target: Some(witness()),
            path: "Target.md".into(),
            display: Some("Alias".into()),
            display_value: Some(Box::new(RuntimeValue::List(vec![RuntimeValue::Icon(
                "book".into(),
            )]))),
            resolved_path: Some(Some("Target.md".into())),
            external: false,
        };
        let source = RuntimeValue::File(Box::new(BasesFile {
            witness: Some(witness()),
            metadata_unavailable: true,
            path: "One/Note.md".into(),
            name: "Name".into(),
            basename: "Base".into(),
            folder: "One".into(),
            extension: "md".into(),
            size: Some(42),
            properties,
            tags: vec!["#Work".into()],
            links: vec![link.clone()],
            embeds: vec![BasesLink {
                external: true,
                path: "https://example.test".into(),
                resolved_path: Some(None),
                ..Default::default()
            }],
            backlinks: vec![BasesLink {
                raw_destination: Some("Other.md".into()),
                source_path: Some(String::new()),
                path: "Other.md".into(),
                ..Default::default()
            }],
            ctime: Some("2026-01-01".into()),
            mtime: Some("2026-01-02".into()),
        }));
        let result = copy(&source);
        assert_eq!(format!("{result:?}"), format!("{source:?}"));
        let RuntimeValue::File(file) = result else {
            panic!("File subtype")
        };
        let RuntimeValue::Regex(_, _, actual_identity) = &file.properties["regex"] else {
            panic!("Regex subtype")
        };
        assert!(Arc::ptr_eq(&identity, actual_identity));
        assert_eq!(file.witness, Some(witness()));
        assert!(matches!(&file.properties["tags"], RuntimeValue::TagList(_)));
        assert_eq!(file.links[0].source_path.as_deref(), Some("One/Note.md"));
        assert_eq!(file.backlinks[0].source_path.as_deref(), Some(""));
        assert_eq!(file.embeds[0].resolved_path, Some(None));
    }

    #[test]
    fn preserves_number_bits_and_none_versus_explicit_empty_provenance() {
        let source = RuntimeValue::List(vec![
            RuntimeValue::Number(-0.0),
            RuntimeValue::Number(f64::from_bits(0x7ff8_0000_0000_0042)),
            RuntimeValue::Link(BasesLink::default()),
            RuntimeValue::Link(BasesLink {
                raw_destination: Some(String::new()),
                source_path: Some(String::new()),
                ..Default::default()
            }),
        ]);
        let RuntimeValue::List(values) = copy(&source) else {
            panic!("List")
        };
        let RuntimeValue::Number(negative_zero) = &values[0] else {
            panic!("Number")
        };
        let RuntimeValue::Number(nan) = &values[1] else {
            panic!("Number")
        };
        assert_eq!(negative_zero.to_bits(), (-0.0f64).to_bits());
        assert_eq!(nan.to_bits(), 0x7ff8_0000_0000_0042);
        let RuntimeValue::Link(unknown) = &values[2] else {
            panic!("Link")
        };
        let RuntimeValue::Link(root) = &values[3] else {
            panic!("Link")
        };
        assert!(unknown.source_path.is_none());
        assert_eq!(root.source_path.as_deref(), Some(""));
        assert_eq!(root.raw_destination.as_deref(), Some(""));
    }

    #[test]
    fn whole_plan_headroom_is_checked_before_the_first_materialization_copy() {
        let source = RuntimeValue::List(vec![RuntimeValue::String("payload".into()); 32]);
        let plan = prepare_clone(&source, &mut |_| Ok(())).unwrap();
        let insufficient = plan.allocation_bytes() - 1;
        let mut copy_work = 0;
        error(
            plan.materialize(insufficient, &mut |work| {
                copy_work += work;
                Ok(())
            })
            .unwrap_err(),
            "budget",
        );
        assert_eq!(copy_work, 0);
        let plan = prepare_clone(&source, &mut |_| Ok(())).unwrap();
        let original = "cancelled\0Original cancellation";
        assert!(
            matches!(plan.materialize(MAX_BASE_REQUEST_BYTES, &mut |_| Err(RuntimeValue::Error(original.into()))), Err(RuntimeValue::Error(message)) if message == original)
        );
        assert_eq!(
            format!("{source:?}"),
            format!(
                "{:?}",
                RuntimeValue::List(vec![RuntimeValue::String("payload".into()); 32])
            )
        );
    }

    #[test]
    fn planning_and_materialization_each_check_work_inside_wide_inputs() {
        let source = RuntimeValue::List(vec![RuntimeValue::Null; 4096]);
        let mut work = 0;
        error(
            prepare_clone(&source, &mut |added| {
                work += added;
                if work > 17 {
                    Err(budget("test work"))
                } else {
                    Ok(())
                }
            })
            .err()
            .unwrap(),
            "budget",
        );
        assert_eq!(work, 18);
        let plan = prepare_clone(&source, &mut |_| Ok(())).unwrap();
        let mut polls = 0;
        error(
            plan.materialize(MAX_BASE_REQUEST_BYTES, &mut |_| {
                polls += 1;
                if polls == 17 {
                    Err(RuntimeValue::Error("cancelled\0mid-copy".into()))
                } else {
                    Ok(())
                }
            })
            .unwrap_err(),
            "cancelled",
        );
        assert_eq!(polls, 17);
        let plan = prepare_clone(&source, &mut |_| Ok(())).unwrap();
        let mut work = 0;
        error(
            plan.materialize(MAX_BASE_REQUEST_BYTES, &mut |added| {
                work += added;
                if work > 17 {
                    Err(budget("pre-reserve container work"))
                } else {
                    Ok(())
                }
            })
            .unwrap_err(),
            "budget",
        );
        assert!(
            work >= 4096,
            "slot work is checked before the fresh reserve"
        );
    }

    #[test]
    fn depth_byte_and_fresh_map_overflow_guards_precede_allocation() {
        for depth in [128, 129] {
            let mut source = RuntimeValue::Null;
            for _ in 0..depth {
                source = RuntimeValue::List(vec![source]);
            }
            let plan = prepare_clone(&source, &mut |_| Ok(()));
            if depth == 128 {
                assert!(plan.is_ok());
            } else {
                error(plan.err().unwrap(), "budget");
            }
        }
        error(
            object_map_allocation_bound(usize::MAX).unwrap_err(),
            "budget",
        );
        let mut planning = Planning {
            bytes: MAX_BASE_REQUEST_BYTES,
            check: &mut |_| Ok(()),
        };
        error(planning.add(1).unwrap_err(), "budget");
        assert!(
            object_map_allocation_bound(0).unwrap() >= size_of::<IndexMap<String, RuntimeValue>>()
        );
        let mut last = 0;
        for len in [1, 3, 7, 14, 15, 31, 32, 1024] {
            let bound = object_map_allocation_bound(len).unwrap();
            assert!(bound > last);
            assert!(bound > len * (size_of::<String>() + size_of::<RuntimeValue>()));
            last = bound;
        }
    }
}
