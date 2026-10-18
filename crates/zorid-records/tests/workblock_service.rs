use std::collections::BTreeMap;
use zorid_core::EntryId;
use zorid_records::{admission, first_party as domain, workblock_service::*, *};
fn id(s: &str) -> Id { Id::new(s).unwrap() }
fn scope() -> Scope { fixed_scope(id("realm"), id("vault"), id("record"), id("root")).unwrap() }
fn range(a: i64, b: i64) -> WorkBlockRange { WorkBlockRange::new(a,b,"UTC").unwrap() }
fn create() -> WorkBlockCommand { WorkBlockCommand::Create {
    record:id("record"), generation:id("root"), operation:id("root"), range:range(0,10), title:None,
} }
fn state() -> State { State::new(domain::schema(), scope()).unwrap() }
fn apply(s: &mut State, op: &str, c: Command) { let p=s.prepare(id(op),c).unwrap(); s.install(p).unwrap(); }
fn created() -> State { let mut s=state(); apply(&mut s,"root",command_for_new(&create(),None).unwrap()); s }
fn remove() -> WorkBlockCommand { WorkBlockCommand::RemoveRef {
    record:id("record"), generation:id("root"), operation:id("remove"),
    expected_revision:WorkBlockRevision([7;32]), task:EntryId::new("missing_note").unwrap(),
} }

#[test]
fn strict_native_command_shapes_and_nullable_title() {
    let expected=serde_json::json!({"op":"create","record":"record","generation":"root","operation":"root",
        "range":{"start_ms":"0","end_ms":"10","timezone":"UTC"},"title":null});
    assert_eq!(serde_json::to_value(create()).unwrap(),expected);
    let mut omitted=expected.clone(); omitted.as_object_mut().unwrap().remove("title");
    assert_eq!(serde_json::from_value::<WorkBlockCommand>(omitted).unwrap(),create());
    let mut title=serde_json::json!({"op":"title","record":"record","generation":"root","operation":"title",
        "expectedRevision":vec![9;32],"title":null});
    assert!(serde_json::from_value::<WorkBlockCommand>(title.clone()).is_ok());
    title.as_object_mut().unwrap().remove("title");
    assert!(serde_json::from_value::<WorkBlockCommand>(title.clone()).is_err());
    title["title"]=serde_json::json!(false);
    assert!(serde_json::from_value::<WorkBlockCommand>(title).is_err());
    for key in ["owner","collection","restores","unexpected"] {
        let mut bad=expected.clone(); bad[key]=serde_json::json!("injected");
        assert!(serde_json::from_value::<WorkBlockCommand>(bad).is_err());
    }
    let mut bad=expected; bad["op"]=serde_json::json!("addRef");
    assert!(serde_json::from_value::<WorkBlockCommand>(bad).is_err());
    assert_eq!(serde_json::to_value(WorkBlockRevision([255;32])).unwrap(),serde_json::json!(vec![255;32]));
    assert!(serde_json::from_value::<WorkBlockRevision>(serde_json::json!(vec![0;31])).is_err());
}

#[test]
fn original_empty_create_bytes_are_fixed_and_native_compatible() {
    let expected=b"{\"format\":1,\"scope\":{\"realm\":\"realm\",\"vault\":\"vault\",\"owner\":\"zorid_firstparty_calendar\",\"collection\":\"workblocks\",\"record\":\"record\",\"generation\":\"root\",\"restores\":null},\"operations\":[]}";
    assert_eq!(empty_state_bytes(&scope()).unwrap(),expected);
    assert_eq!(empty_state_bytes(&scope()).unwrap(),state().snapshot().unwrap());
    assert_ne!(empty_state_bytes(&scope()).unwrap(),created().snapshot().unwrap());
    for change in 0..3 {
        let mut bad=scope();
        match change { 0=>bad.owner=id("other"),1=>bad.collection=id("other"),_=>bad.restores=Some(id("previous")) }
        assert_eq!(empty_state_bytes(&bad),Err(Error::Scope));
    }
    let mut bad=create();
    if let WorkBlockCommand::Create {operation,..}=&mut bad { *operation=id("wrong"); }
    assert_eq!(command_for_new(&bad,None),Err(ServiceError::InvalidRequest));
}

#[test]
fn every_mutation_replays_original_command_without_state() {
    let commands=[create(),
        WorkBlockCommand::Move {record:id("record"),generation:id("root"),operation:id("move"),expected_revision:WorkBlockRevision([7;32]),range:range(20,30)},
        WorkBlockCommand::Title {record:id("record"),generation:id("root"),operation:id("title"),expected_revision:WorkBlockRevision([7;32]),title:None},
        WorkBlockCommand::AddRef {record:id("record"),generation:id("root"),operation:id("add"),expected_revision:WorkBlockRevision([7;32]),task:EntryId::new("missing_note").unwrap()},
        WorkBlockCommand::Delete {record:id("record"),generation:id("root"),operation:id("delete"),expected_revision:WorkBlockRevision([7;32])}];
    for input in commands {
        let c=command_for_new(&input,None).unwrap();
        let bytes=admission::local_request(&scope(),&[7;32],&c).unwrap();
        assert_eq!(command_for_replay(&input,&scope(),&[7;32],&bytes).unwrap(),c);
        assert_eq!(command_for_replay(&input,&scope(),&[8;32],&bytes),Err(ServiceError::OperationCollision));
        let mut wrong=scope(); wrong.vault=id("other_vault");
        assert_eq!(command_for_replay(&input,&wrong,&[7;32],&bytes),Err(ServiceError::OperationCollision));
    }
}

#[test]
fn remove_replay_retains_original_tags_after_remove_readd_and_restart() {
    let mut s=created(); let task=EntryId::new("missing_note").unwrap();
    apply(&mut s,"add",domain::add_task(&task));
    let original=command_for_new(&remove(),Some(&s)).unwrap();
    let journal=admission::local_request(&scope(),&[7;32],&original).unwrap();
    apply(&mut s,"remove",original.clone()); apply(&mut s,"readd",domain::add_task(&task));
    let mut reopened=State::restore(domain::schema(),&s.snapshot().unwrap()).unwrap();
    assert_ne!(command_for_new(&remove(),Some(&reopened)).unwrap(),original);
    let replay=command_for_replay(&remove(),&scope(),&[7;32],&journal).unwrap();
    assert_eq!(replay,original);
    // Even applying the recovered command under a new identity cannot erase readd.
    apply(&mut reopened,"replay_effect",replay);
    assert_eq!(read_value(&reopened).unwrap().unwrap().task_refs,vec![task]);
    let mut other=remove(); if let WorkBlockCommand::RemoveRef {task,..}=&mut other { *task=EntryId::new("other").unwrap(); }
    assert_eq!(command_for_replay(&other,&scope(),&[7;32],&journal),Err(ServiceError::OperationCollision));
    assert_eq!(command_for_new(&remove(),None),Err(ServiceError::InvalidRequest));
    let mut wrong=scope(); wrong.record=id("other");
    let other=State::new(domain::schema(),wrong).unwrap();
    assert_eq!(command_for_new(&remove(),Some(&other)),Err(ServiceError::Domain(Error::Scope)));
}

#[test]
fn corrupt_journal_and_valid_semantic_collisions_are_distinct() {
    let c=command_for_new(&create(),None).unwrap();
    let bytes=admission::local_request(&scope(),&[7;32],&c).unwrap();
    let mut whitespace=bytes.clone(); whitespace.push(b' ');
    for bad in [b"garbage".to_vec(),whitespace,bytes[..bytes.len()-1].to_vec()] {
        assert_eq!(command_for_replay(&create(),&scope(),&[7;32],&bad),Err(ServiceError::CorruptJournal));
    }
    let wrong=admission::local_request(&scope(),&[7;32],&Command::Delete).unwrap();
    assert_eq!(command_for_replay(&create(),&scope(),&[7;32],&wrong),Err(ServiceError::OperationCollision));
    let wrong=admission::local_request(&scope(),&[7;32],&Command::Patch(vec![Action::Remove {
        field:id("task_refs"),member:id("missing_note"),tags:vec![]
    },Action::Remove { field:id("task_refs"),member:id("missing_note"),tags:vec![] }])).unwrap();
    assert_eq!(command_for_replay(&remove(),&scope(),&[7;32],&wrong),Err(ServiceError::OperationCollision));
}

#[test]
fn views_preserve_all_candidates_nulls_flags_and_unknown_status_counts() {
    let base=created(); let mut merged=base.clone();
    for (name,r,title) in [("a",range(20,30),Some("A".into())),("z",range(40,50),None)] {
        let p=base.prepare(id(name),Command::Patch(vec![
            Action::Write {field:id("range"),cell:r.cell().unwrap()},
            Action::Write {field:id("title"),cell:title.map(|s|Cell::Value(Value::String(s))).unwrap_or(Cell::Unset)},
        ])).unwrap(); merged.receive(p.payload()).unwrap();
    }
    let view=read_value(&merged).unwrap().unwrap();
    assert_eq!(view.ranges.len(),2); assert_eq!(view.titles.len(),2);
    assert!(view.titles.iter().any(|c|c.title.is_none()));
    let json=serde_json::to_value(&view).unwrap();
    assert!(json.get("taskRefs").is_some()); assert!(json.get("task_refs").is_none());
    assert_eq!(read_value(&state()).unwrap(),None);
    let read=WorkBlockRead {record:id("record"),generation:id("root"),revision:WorkBlockRevision([7;32]),
        created:true,deleted:false,block:Some(view),unresolved:[("future_status".into(),"9007199254740993".into())].into_iter().collect()};
    assert_eq!(serde_json::from_value::<WorkBlockRead>(serde_json::to_value(&read).unwrap()).unwrap(),read);
    apply(&mut merged,"delete",domain::delete()); assert_eq!(read_value(&merged).unwrap(),None);
}

#[test]
fn window_budgets_and_all_candidate_intersection_remain_domain_owned() {
    let q=WindowQuery {from:"20".into(),until:"21".into(),limit:64,bytes:1_048_576};
    let base=created(); let mut merged=base.clone();
    for (name,r) in [("a",range(20,30)),("z",range(40,50))] {
        let p=base.prepare(id(name),domain::set_range(&r).unwrap()).unwrap(); merged.receive(p.payload()).unwrap();
    }
    assert!(validate_window(&q).unwrap().intersects(&domain::read(&merged).unwrap().unwrap()).unwrap());
    for (limit,bytes) in [(0,1),(65,1),(1,0),(1,1_048_577)] {
        assert_eq!(validate_window(&WindowQuery {limit,bytes,..q.clone()}),Err(ServiceError::InvalidRequest));
    }
    for (from,until) in [("00","1"),("0","2678400001"),("1","1")] {
        assert!(matches!(validate_window(&WindowQuery {from:from.into(),until:until.into(),..q.clone()}),Err(ServiceError::Domain(_))));
    }
    assert!(validate_window(&WindowQuery {from:"0".into(),until:"2678400000".into(),..q}).is_ok());
}

#[test]
fn helpers_delegate_domain_validation_and_reject_non_mutations() {
    let mut invalid=create();
    if let WorkBlockCommand::Create {range,..}=&mut invalid { range.start_ms="00".into(); }
    assert_eq!(command_for_new(&invalid,None),Err(ServiceError::Domain(Error::InvalidValue)));
    let input=WorkBlockCommand::Title {record:id("record"),generation:id("root"),operation:id("title"),
        expected_revision:WorkBlockRevision([7;32]),title:Some("é".repeat(257))};
    assert_eq!(command_for_new(&input,None),Err(ServiceError::Domain(Error::InvalidValue)));
    for input in [WorkBlockCommand::Read {record:id("record"),generation:id("root")},
        WorkBlockCommand::Window {from_ms:"0".into(),until_ms:"1".into(),limit:1,byte_limit:1,cursor:None},
        WorkBlockCommand::Changes {after:"0".into(),limit:1}] {
        assert!(!input.may_commit());
        assert_eq!(command_for_new(&input,None),Err(ServiceError::InvalidRequest));
    }
    let bad: Id=serde_json::from_str("\"bad id\"").unwrap();
    assert_eq!(fixed_scope(bad,id("vault"),id("record"),id("root")),Err(Error::InvalidId));
}

#[test]
fn replay_binds_complete_original_scope_and_public_witness() {
    let input=remove();
    let command=command_for_new(&input,Some(&created())).unwrap();
    for field in ["realm","vault","owner","collection","record","generation","restores"] {
        let mut foreign=scope();
        match field {
            "realm"=>foreign.realm=id("foreign"),
            "vault"=>foreign.vault=id("foreign"),
            "owner"=>foreign.owner=id("foreign"),
            "collection"=>foreign.collection=id("foreign"),
            "record"=>foreign.record=id("foreign"),
            "generation"=>foreign.generation=id("foreign"),
            _=>foreign.restores=Some(id("foreign")),
        }
        let journal=admission::local_request(&foreign,&[7;32],&command).unwrap();
        assert_eq!(command_for_replay(&input,&scope(),&[7;32],&journal),
            Err(ServiceError::OperationCollision),"{field}");
    }
    let journal=admission::local_request(&scope(),&[7;32],&command).unwrap();
    let mut changed=input;
    if let WorkBlockCommand::RemoveRef {expected_revision,..}=&mut changed {
        *expected_revision=WorkBlockRevision([8;32]);
    }
    assert_eq!(command_for_replay(&changed,&scope(),&[7;32],&journal),
        Err(ServiceError::OperationCollision));
    // Empty observed sets are legitimate retained removes, not missing journals.
    assert_eq!(command_for_replay(&remove(),&scope(),&[7;32],&journal).unwrap(),command);
}

#[test]
fn replay_rejects_changed_title_range_and_remove_action() {
    let input=create();
    let command=command_for_new(&input,None).unwrap();
    let journal=admission::local_request(&scope(),&[7;32],&command).unwrap();
    for changed in [
        WorkBlockCommand::Create {record:id("record"),generation:id("root"),
            operation:id("root"),range:range(0,10),title:Some("changed".into())},
        WorkBlockCommand::Create {record:id("record"),generation:id("root"),
            operation:id("root"),range:range(1,11),title:None},
    ] {
        assert_eq!(command_for_replay(&changed,&scope(),&[7;32],&journal),
            Err(ServiceError::OperationCollision));
    }
    for command in [domain::add_task(&EntryId::new("missing_note").unwrap()),
        Command::Patch(vec![Action::Remove {
            field:id("other_set"),member:id("missing_note"),tags:vec![],
        }]),domain::delete()] {
        let journal=admission::local_request(&scope(),&[7;32],&command).unwrap();
        assert_eq!(command_for_replay(&remove(),&scope(),&[7;32],&journal),
            Err(ServiceError::OperationCollision));
    }
}

#[test]
fn absent_read_and_empty_window_keep_native_nulls_and_decimal_strings() {
    let read=WorkBlockRead {record:id("record"),generation:id("root"),
        revision:WorkBlockRevision([0;32]),created:false,deleted:false,block:None,
        unresolved:BTreeMap::new()};
    let expected=serde_json::json!({"record":"record","generation":"root",
        "revision":vec![0;32],"created":false,"deleted":false,"block":null,"unresolved":{}});
    assert_eq!(serde_json::to_value(&read).unwrap(),expected);
    let page=WorkBlockWindowPage {blocks:vec![],cursor:None,incomplete:false,
        watermark:"9007199254740993".into(),scanned:0,bytes:0};
    assert_eq!(serde_json::to_value(&page).unwrap(),serde_json::json!({
        "blocks":[],"cursor":null,"incomplete":false,"watermark":"9007199254740993",
        "scanned":0,"bytes":0}));
}
