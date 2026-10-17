//! Strict durable-command boundary over the shared mutation mapper. The host
//! remains responsible for receipt/intent authorization and atomic persistence.
use super::{domain, error, json, metadata, parse, reusable_state, Result};
use serde::Deserialize;
use wasm_bindgen::prelude::*;
use zorid_client_sync::TextState;
use zorid_core::EntryState;
use zorid_file_sync::{mutation as mapper, v2};

const MAX_COMMAND_JSON_BYTES: usize = 4 * 1024 * 1024;
pub(super) fn command(input: &str) -> Result<mapper::FamilyCommand> {
    if input.len() > MAX_COMMAND_JSON_BYTES {
        return Err("family command exceeds fixture budget".into());
    }
    let value: mapper::FamilyCommand = parse(input)?;
    domain(value.validate())?;
    Ok(value)
}
#[wasm_bindgen(js_name = validateFamilyCommand)]
pub fn validate_family_command(input: &str) -> std::result::Result<String, JsValue> {
    json(&command(input).map_err(error)?).map_err(error)
}
pub(super) fn replay(original: &str, candidate: &str) -> Result<()> {
    domain(command(candidate)?.check_replay(&command(original)?))
}
#[wasm_bindgen(js_name = checkFamilyCommandReplay)]
pub fn check_family_command_replay(
    original: &str,
    candidate: &str,
) -> std::result::Result<(), JsValue> {
    replay(original, candidate).map_err(error)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RequirementsInput {
    command: mapper::FamilyCommand,
    entries: Vec<EntryState>,
    graph: v2::State,
    text: Option<TextState>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlanInput {
    command: mapper::FamilyCommand,
    entries: Vec<EntryState>,
    graph: v2::State,
    text: Option<TextState>,
    allocation: mapper::Allocation,
}
fn input_budget(
    command: &mapper::FamilyCommand,
    entries: &[EntryState],
    graph: &v2::State,
    text: Option<&TextState>,
) -> Result<()> {
    domain(command.validate())?;
    // The command is persisted independently, then supplied beside state later.
    // Reserve room for graph/entries/text when enforcing the same command cap.
    if json(command)?.len() > MAX_COMMAND_JSON_BYTES {
        return Err("family command exceeds fixture budget".into());
    }
    reusable_state(&entries)?;
    reusable_state(graph)?;
    if let Some(text) = text {
        reusable_state(text)?;
    }
    Ok(())
}
pub(super) fn requirements(input: &str) -> Result<String> {
    let input: RequirementsInput = parse(input)?;
    input_budget(
        &input.command,
        &input.entries,
        &input.graph,
        input.text.as_ref(),
    )?;
    let result = domain(mapper::requirements(
        &input.command.request,
        &input.entries,
        &input.graph,
        input.command.create_mode,
        input.text.as_ref(),
    ))?;
    json(&result)
}
#[wasm_bindgen(js_name = familyMutationRequirements)]
pub fn family_mutation_requirements(input: &str) -> std::result::Result<String, JsValue> {
    requirements(input).map_err(error)
}
#[wasm_bindgen]
pub struct WasmFamilyMutationPlan {
    plan: mapper::MutationPlan,
}
pub(super) fn plan(input: &str) -> Result<WasmFamilyMutationPlan> {
    let input: PlanInput = parse(input)?;
    input_budget(
        &input.command,
        &input.entries,
        &input.graph,
        input.text.as_ref(),
    )?;
    let plan = domain(mapper::plan_mutation(
        &input.command.request,
        &input.entries,
        &input.graph,
        input.command.create_mode,
        input.text.as_ref(),
        &input.allocation,
    ))?;
    reusable_state(&plan.expected_entries)?;
    reusable_state(&plan.expected_graph)?;
    reusable_state(&plan.next_graph)?;
    if let Some(text) = &plan.text {
        reusable_state(&text.plan().expected_state)?;
        reusable_state(&text.plan().next_state)?;
    }
    Ok(WasmFamilyMutationPlan { plan })
}
#[wasm_bindgen(js_name = planFamilyMutation)]
pub fn plan_family_mutation(input: &str) -> std::result::Result<WasmFamilyMutationPlan, JsValue> {
    plan(input).map_err(error)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CheckInput {
    entries: Vec<EntryState>,
    graph: v2::State,
    text: Option<TextState>,
    allocated_ids_unused: bool,
}
#[wasm_bindgen]
impl WasmFamilyMutationPlan {
    #[wasm_bindgen(js_name = resultJson)]
    pub fn result_json(&self) -> std::result::Result<String, JsValue> {
        json(&self.plan).map_err(error)
    }
    #[wasm_bindgen(js_name = metadataJson)]
    pub fn metadata_json(&self) -> std::result::Result<String, JsValue> {
        self.metadata().map_err(error)
    }
    #[wasm_bindgen(js_name = checkPreconditions)]
    pub fn check_preconditions(&self, actual: &str) -> std::result::Result<(), JsValue> {
        self.check(actual).map_err(error)
    }
}
impl WasmFamilyMutationPlan {
    pub(super) fn check(&self, actual: &str) -> Result<()> {
        let actual: CheckInput = parse(actual)?;
        domain(self.plan.check_preconditions(
            &actual.entries,
            &actual.graph,
            actual.text.as_ref(),
            actual.allocated_ids_unused,
        ))
    }
    pub(super) fn metadata(&self) -> Result<String> {
        let mut output = Vec::with_capacity(
            self.plan.authored_files.len() + usize::from(self.plan.text.is_some()),
        );
        for authored in &self.plan.authored_files {
            let payload = domain(v2::Payload::decode(&authored.payload_bytes))?;
            if payload.id != authored.update_id {
                return Err("authored file identity mismatch".into());
            }
            output.push(metadata(
                "files",
                &payload.scope.realm_id,
                &payload.scope.vault_id,
                &payload.id,
                &authored.payload_bytes,
                None,
            )?);
        }
        if let Some(change) = &self.plan.text {
            let authored = &change.plan().authored;
            output.push(metadata(
                "text",
                &authored.identity.realm_id,
                &authored.identity.vault_id,
                &authored.update_id,
                &authored.payload_bytes,
                Some(&authored.identity),
            )?);
        }
        json(&output)
    }
}
