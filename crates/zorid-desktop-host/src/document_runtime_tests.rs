use super::*;
use zorid_core::{EntryId, EntryKind, Mutation, MutationRequest, VaultPath};
fn id(v: &str) -> OperationId {
    OperationId::new(v).unwrap()
}
fn create(vault: &mut NativeVault) {
    vault
        .apply(&MutationRequest {
            operation_id: id("create"),
            mutation: Mutation::Create {
                id: EntryId::new("note").unwrap(),
                path: VaultPath::new("Note.md").unwrap(),
                kind: EntryKind::File,
                content: Some(b"# Heading\nneedle\n".to_vec()),
            },
        })
        .unwrap();
}
fn execute(s: &mut Sessions, v: &mut NativeVault, client: &str, c: Command) -> Value {
    s.execute(v, &id(client), c).unwrap().value
}
fn owner(s: &mut Sessions, v: &mut NativeVault, seq: u64, command: Owner) -> Value {
    let reply = execute(
        s,
        v,
        "owner",
        Command::Owner {
            sequence: Counter(seq),
            command,
        },
    );
    assert_eq!(
        execute(
            s,
            v,
            "owner",
            Command::OwnerAck {
                sequence: Counter(seq)
            }
        ),
        json!(true)
    );
    reply
}
fn start(s: &mut Sessions, v: &mut NativeVault) -> OperationId {
    owner(
        s,
        v,
        1,
        Owner::Wake {
            monotonic_ms: Counter(1),
        },
    );
    v.document_runtime_update().unwrap().lifetime
}
fn request(
    s: &mut Sessions,
    v: &mut NativeVault,
    client: &str,
    seq: u64,
    local: u64,
    life: &OperationId,
) -> Value {
    execute(
        s,
        v,
        client,
        Command::Control {
            sequence: Counter(seq),
            command: Feature::Request {
                lifetime: life.clone(),
                id: Counter(local),
                max_pumps: 8,
                max_restarts: 1,
                force_rebuild: false,
            },
        },
    )
}
fn ack(s: &mut Sessions, v: &mut NativeVault, client: &str, seq: u64) {
    assert_eq!(
        execute(
            s,
            v,
            client,
            Command::Ack {
                sequence: Counter(seq)
            }
        ),
        json!(true)
    );
}
fn drive(s: &mut Sessions, v: &mut NativeVault, mut owner_seq: u64) {
    for _ in 0..100 {
        let selected = v.document_runtime_snapshot().unwrap();
        // A control accepted after Dispatch can report WaitForWake while the
        // already-issued effect still belongs to this executor. Deliver that
        // exact token before consulting the no-pending-effect continuation.
        if let Some(e) = selected.in_flight {
            execute(
                s,
                v,
                "owner",
                Command::Step {
                    lifetime: e.lifetime,
                    effect_id: Counter(e.id),
                },
            );
            continue;
        }
        match selected.execution {
            zorid_native::DocumentRuntimeExecution::Dispatch => {
                panic!("dispatch requires an issued effect")
            }
            zorid_native::DocumentRuntimeExecution::Yield => {
                owner_seq += 1;
                owner(s, v, owner_seq, Owner::Continue {});
            }
            _ => return,
        }
    }
    panic!("bounded fixture did not finish");
}
#[test]
fn control_ack_replays_exact_public_result_and_other_namespaces_remain_available() {
    let root = tempfile::tempdir().unwrap();
    let mut v = NativeVault::open(root.path()).unwrap();
    create(&mut v);
    let mut s = Sessions::default();
    let life = start(&mut s, &mut v);
    let original = request(&mut s, &mut v, "client", 1, 1, &life);
    assert_eq!(request(&mut s, &mut v, "client", 1, 1, &life), original);
    assert!(s
        .execute(
            &mut v,
            &id("client"),
            Command::Control {
                sequence: Counter(1),
                command: Feature::Cancel {
                    lifetime: life.clone(),
                    id: Counter(1)
                }
            }
        )
        .is_err());
    // A held feature ACK cannot block the one separate trusted-owner slot.
    owner(&mut s, &mut v, 2, Owner::SourceHint {});
    ack(&mut s, &mut v, "client", 1);
    ack(&mut s, &mut v, "client", 1);
    assert!(s
        .execute(
            &mut v,
            &id("client"),
            Command::Control {
                sequence: Counter(1),
                command: Feature::Cancel {
                    lifetime: life,
                    id: Counter(1)
                }
            }
        )
        .is_err());
}
#[test]
fn local_ids_and_final_ack_are_scoped_and_cannot_free_active_or_foreign_records() {
    let root = tempfile::tempdir().unwrap();
    let mut v = NativeVault::open(root.path()).unwrap();
    create(&mut v);
    let mut s = Sessions::default();
    let life = start(&mut s, &mut v);
    request(&mut s, &mut v, "first", 1, 1, &life);
    let pending = v.document_runtime_snapshot().unwrap();
    assert_eq!(
        pending.execution,
        zorid_native::DocumentRuntimeExecution::WaitForWake
    );
    assert!(pending.in_flight.is_some());
    ack(&mut s, &mut v, "first", 1);
    assert!(s
        .execute(
            &mut v,
            &id("first"),
            Command::OutcomeAck {
                lifetime: life.clone(),
                id: Counter(1)
            }
        )
        .is_err());
    assert!(s
        .execute(
            &mut v,
            &id("other"),
            Command::Control {
                sequence: Counter(1),
                command: Feature::Cancel {
                    lifetime: life.clone(),
                    id: Counter(1)
                }
            }
        )
        .is_err());
    assert_eq!(s.count(), 1);
    drive(&mut s, &mut v, 1);
    let frame = execute(&mut s, &mut v, "first", Command::Observe);
    assert_eq!(frame["outcomes"][0]["outcome"]["id"], "1");
    assert_eq!(frame["outcomes"][0]["outcome"]["kind"], "finished");
    assert!(s
        .execute(
            &mut v,
            &id("other"),
            Command::OutcomeAck {
                lifetime: life.clone(),
                id: Counter(1)
            }
        )
        .is_err());
    execute(
        &mut s,
        &mut v,
        "first",
        Command::OutcomeAck {
            lifetime: life.clone(),
            id: Counter(1),
        },
    );
    execute(
        &mut s,
        &mut v,
        "first",
        Command::OutcomeAck {
            lifetime: life.clone(),
            id: Counter(1),
        },
    );
    assert!(s
        .execute(
            &mut v,
            &id("first"),
            Command::OutcomeAck {
                lifetime: life,
                id: Counter(2)
            }
        )
        .is_err());
    assert_eq!(s.count(), 0);
}
#[test]
fn cancel_outcome_is_delivered_even_when_update_revision_is_unchanged() {
    let root = tempfile::tempdir().unwrap();
    let mut v = NativeVault::open(root.path()).unwrap();
    create(&mut v);
    let mut s = Sessions::default();
    let life = start(&mut s, &mut v);
    request(&mut s, &mut v, "first", 1, 1, &life);
    ack(&mut s, &mut v, "first", 1);
    request(&mut s, &mut v, "second", 1, 1, &life);
    ack(&mut s, &mut v, "second", 1);
    let before = v.document_runtime_update().unwrap().revision;
    let cancelled = execute(
        &mut s,
        &mut v,
        "first",
        Command::Control {
            sequence: Counter(2),
            command: Feature::Cancel {
                lifetime: life,
                id: Counter(1),
            },
        },
    );
    assert_eq!(v.document_runtime_update().unwrap().revision, before);
    assert_eq!(
        cancelled["frame"]["outcomes"][0]["outcome"]["kind"],
        "cancelled"
    );
    assert_eq!(
        execute(&mut s, &mut v, "second", Command::Observe)["outcomes"],
        json!([])
    );
}
#[test]
fn finished_unacknowledged_outcomes_hold_capacity_and_maximum_frame_fits64k() {
    let root = tempfile::tempdir().unwrap();
    let mut v = NativeVault::open(root.path()).unwrap();
    create(&mut v);
    let mut s = Sessions::default();
    let life = start(&mut s, &mut v);
    for n in 1..=32 {
        request(&mut s, &mut v, "client", n, n, &life);
        ack(&mut s, &mut v, "client", n);
    }
    assert!(s
        .execute(
            &mut v,
            &id("client"),
            Command::Control {
                sequence: Counter(33),
                command: Feature::Request {
                    lifetime: life.clone(),
                    id: Counter(33),
                    max_pumps: 8,
                    max_restarts: 1,
                    force_rebuild: false
                }
            }
        )
        .is_err());
    drive(&mut s, &mut v, 1);
    let frame = execute(&mut s, &mut v, "client", Command::Observe);
    assert_eq!(frame["outcomes"].as_array().unwrap().len(), 32);
    assert_eq!(s.count(), 32);
    bounded(&frame).unwrap();
    let reply = execute(
        &mut s,
        &mut v,
        "client",
        Command::Control {
            sequence: Counter(33),
            command: Feature::Cancel {
                lifetime: life.clone(),
                id: Counter(1),
            },
        },
    );
    bounded(&reply).unwrap();
    ack(&mut s, &mut v, "client", 33);
    execute(
        &mut s,
        &mut v,
        "client",
        Command::OutcomeAck {
            lifetime: life.clone(),
            id: Counter(1),
        },
    );
    request(&mut s, &mut v, "client", 34, 33, &life);
    assert_eq!(s.count(), 32);
}
#[test]
fn counters_are_lossless_above_js_safe_integer_and_proof_input_is_rejected() {
    let root = tempfile::tempdir().unwrap();
    let mut v = NativeVault::open(root.path()).unwrap();
    create(&mut v);
    let mut s = Sessions::default();
    let life = start(&mut s, &mut v);
    let n = 9_007_199_254_740_993u64;
    let reply = request(&mut s, &mut v, "client", n, n, &life);
    assert_eq!(reply["sequence"], n.to_string());
    ack(&mut s, &mut v, "client", n);
    assert!(serde_json::from_value::<Feature>(
        json!({"kind":"complete","id":"1","result":{"current":true}})
    )
    .is_err());
    assert!(serde_json::from_value::<Counter>(json!(n)).is_err());
    assert!(serde_json::from_value::<Counter>(json!("01")).is_err());
    assert!(serde_json::from_value::<crate::documents::Request>(json!({"schemaVersion":1,"command":{"op":"runtime_owner","sequence":"1","command":{"kind":"continue"}}})).is_ok());
}
#[test]
fn owner_and_step_ack_retries_never_drive_another_effect() {
    let root = tempfile::tempdir().unwrap();
    let mut v = NativeVault::open(root.path()).unwrap();
    create(&mut v);
    let mut s = Sessions::default();
    let command = Owner::Wake {
        monotonic_ms: Counter(1),
    };
    let first = execute(
        &mut s,
        &mut v,
        "owner",
        Command::Owner {
            sequence: Counter(1),
            command: command.clone(),
        },
    );
    assert_eq!(
        execute(
            &mut s,
            &mut v,
            "owner",
            Command::Owner {
                sequence: Counter(1),
                command
            }
        ),
        first
    );
    execute(
        &mut s,
        &mut v,
        "owner",
        Command::OwnerAck {
            sequence: Counter(1),
        },
    );
    let e = v.document_runtime_snapshot().unwrap().in_flight.unwrap();
    let one = execute(
        &mut s,
        &mut v,
        "owner",
        Command::Step {
            lifetime: e.lifetime.clone(),
            effect_id: Counter(e.id),
        },
    );
    let two = execute(
        &mut s,
        &mut v,
        "owner",
        Command::Step {
            lifetime: e.lifetime,
            effect_id: Counter(e.id),
        },
    );
    assert_eq!(one, two);
    assert!(v
        .document_runtime_snapshot()
        .unwrap()
        .last_step
        .unwrap()
        .receipt
        .pump
        .is_none());
}
#[test]
fn release_one_client_preserves_another_and_last_release_drains_then_can_reopen() {
    let root = tempfile::tempdir().unwrap();
    let mut v = NativeVault::open(root.path()).unwrap();
    create(&mut v);
    let mut s = Sessions::default();
    let life = start(&mut s, &mut v);
    request(&mut s, &mut v, "first", 1, 1, &life);
    ack(&mut s, &mut v, "first", 1);
    request(&mut s, &mut v, "second", 1, 1, &life);
    ack(&mut s, &mut v, "second", 1);
    s.release(&mut v, &id("first"), false).unwrap();
    assert_eq!(s.count(), 1);
    assert!(v.document_runtime_update().unwrap().has_foreground_demand);
    s.release(&mut v, &id("second"), true).unwrap();
    assert_eq!(s.count(), 0);
    assert_eq!(
        v.document_runtime_snapshot().unwrap().execution,
        zorid_native::DocumentRuntimeExecution::Quiesced
    );
    owner(
        &mut s,
        &mut v,
        2,
        Owner::Wake {
            monotonic_ms: Counter(2),
        },
    );
    assert_ne!(v.document_runtime_update().unwrap().lifetime, life);
    assert_eq!(v.list().unwrap().len(), 1);
}
#[test]
fn request_ack_replay_does_not_readd_a_finished_demand_after_outcome_ack() {
    let root = tempfile::tempdir().unwrap();
    let mut v = NativeVault::open(root.path()).unwrap();
    create(&mut v);
    let mut s = Sessions::default();
    let life = start(&mut s, &mut v);
    let original = request(&mut s, &mut v, "client", 1, 1, &life);
    drive(&mut s, &mut v, 1);
    execute(
        &mut s,
        &mut v,
        "client",
        Command::OutcomeAck {
            lifetime: life.clone(),
            id: Counter(1),
        },
    );
    let replay = request(&mut s, &mut v, "client", 1, 1, &life);
    assert_eq!(replay["sequence"], original["sequence"]);
    assert_eq!(replay["command"], original["command"]);
    assert_eq!(replay["frame"], original["frame"]);
    assert_eq!(replay["snapshot"]["execution"], "waitForWake");
    assert!(replay["snapshot"]["inFlight"].is_null());
    assert_eq!(s.count(), 0);
    ack(&mut s, &mut v, "client", 1);
    assert!(s
        .execute(
            &mut v,
            &id("client"),
            Command::Control {
                sequence: Counter(2),
                command: Feature::Request {
                    lifetime: life,
                    id: Counter(1),
                    max_pumps: 8,
                    max_restarts: 1,
                    force_rebuild: false
                }
            }
        )
        .is_err());
}

#[test]
fn authoritative_owner_replacement_expires32old_slots_without_cross_lifetime_ack() {
    let root = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let mut v = NativeVault::open(root.path()).unwrap();
    create(&mut v);
    let mut s = Sessions::default();
    let old = start(&mut s, &mut v);
    for n in 1..=32 {
        execute(
            &mut s,
            &mut v,
            "client",
            Command::Control {
                sequence: Counter(n),
                command: Feature::Request {
                    lifetime: old.clone(),
                    id: Counter(n),
                    max_pumps: 8,
                    max_restarts: 1,
                    force_rebuild: n == 1,
                },
            },
        );
        // Leave the final control ACK outstanding to test its expiry too.
        if n < 32 {
            ack(&mut s, &mut v, "client", n);
        }
    }
    assert_eq!(s.count(), 32);
    v.enable_local_document_cache(cache.path().join("new.sqlite"))
        .unwrap();
    let expired = execute(&mut s, &mut v, "client", Command::Observe);
    assert!(expired["update"].is_null());
    assert_eq!(expired["outcomes"], json!([]));
    assert_eq!(s.count(), 0);
    assert!(s
        .execute(
            &mut v,
            &id("client"),
            Command::OutcomeAck {
                lifetime: old.clone(),
                id: Counter(1)
            }
        )
        .is_err());
    assert!(s
        .execute(
            &mut v,
            &id("client"),
            Command::Control {
                sequence: Counter(32),
                command: Feature::Cancel {
                    lifetime: old,
                    id: Counter(1)
                }
            }
        )
        .is_err());
    owner(
        &mut s,
        &mut v,
        2,
        Owner::Wake {
            monotonic_ms: Counter(2),
        },
    );
    let fresh = v.document_runtime_update().unwrap().lifetime;
    for n in 33..=64 {
        request(&mut s, &mut v, "client", n, n, &fresh);
        ack(&mut s, &mut v, "client", n);
    }
    assert_eq!(s.count(), 32);
    // The expired explicit rebuild was never replayed into the replacement.
    let selected = v.document_runtime_snapshot().unwrap().in_flight.unwrap();
    assert!(matches!(selected.kind, Effect::Observe));
    assert_eq!(v.list().unwrap().len(), 1);
}

#[test]
fn retired_rebuild_drain_clears_actual_host_pin_maps_without_retaining_final_ack() {
    fn doc(v: &mut NativeVault, s: &mut crate::documents::Sessions, command: Value) -> Value {
        let request = serde_json::from_value::<crate::documents::Request>(
            json!({"schemaVersion":1,"command":command}),
        )
        .unwrap();
        let (_, body) =
            crate::documents::execute(v, s, &id("client"), &id("lease"), request).unwrap();
        serde_json::from_slice::<Value>(&body).unwrap()["value"].clone()
    }
    let root = tempfile::tempdir().unwrap();
    let mut v = NativeVault::open(root.path()).unwrap();
    create(&mut v);
    v.initialize_document_index().unwrap();
    let stage = v.begin_document_index().unwrap();
    v.pump_document_index(&stage).unwrap();
    v.publish_document_index(&stage).unwrap();
    let mut sessions = crate::documents::Sessions::default();
    doc(&mut v, &mut sessions, json!({"op":"open","pinId":"1"}));
    assert_eq!(sessions.retained_pin_count(), 1);
    doc(
        &mut v,
        &mut sessions,
        json!({"op":"runtime_owner","sequence":"1","command":{"kind":"wake","monotonicMs":"1"}}),
    );
    doc(
        &mut v,
        &mut sessions,
        json!({"op":"runtime_owner_ack","sequence":"1"}),
    );
    let life = v.document_runtime_update().unwrap().lifetime;
    doc(
        &mut v,
        &mut sessions,
        json!({"op":"runtime_control","sequence":"1","command":{"kind":"request","lifetime":life,"id":"1","maxPumps":8,"maxRestarts":1,"forceRebuild":true}}),
    );
    let selected = v.document_runtime_snapshot().unwrap().in_flight.unwrap();
    doc(
        &mut v,
        &mut sessions,
        json!({"op":"runtime_step","lifetime":selected.lifetime,"effectId":selected.id.to_string()}),
    );
    assert!(matches!(
        v.document_runtime_snapshot()
            .unwrap()
            .in_flight
            .unwrap()
            .kind,
        Effect::Rebuild
    ));
    doc(
        &mut v,
        &mut sessions,
        json!({"op":"runtime_owner","sequence":"2","command":{"kind":"retire"}}),
    );
    let selected = v.document_runtime_snapshot().unwrap().in_flight.unwrap();
    doc(
        &mut v,
        &mut sessions,
        json!({"op":"runtime_step","lifetime":selected.lifetime,"effectId":selected.id.to_string()}),
    );
    assert_eq!(sessions.retained_pin_count(), 0);
    let final_state = v.document_runtime_snapshot().unwrap();
    assert!(final_state.last_step.is_none());
    assert_eq!(
        final_state.execution,
        zorid_native::DocumentRuntimeExecution::Quiesced
    );
}

#[test]
fn replacement_expires_pending_control_ack_without_free_slot_success() {
    let mut slot = ControlSlot::<Feature>::default();
    let command = Feature::Cancel {
        lifetime: id("life"),
        id: Counter(1),
    };
    slot.pending = Some((5, command.clone(), json!({"sequence":"5"})));
    slot.expire();
    assert!(slot.ack(5).is_err());
    assert!(slot.replay(5, &command).is_err());
    assert!(slot.replay(6, &command).unwrap().is_none());
}
