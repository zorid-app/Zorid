//! One request per process: each run reconstructs a replica from supplied updates.
use serde::Deserialize;
use serde_json::json;
use std::io::{self, Read};
use zorid_crdt::TextReplica;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Operation {
    Insert { index: u32, text: String },
    Delete { index: u32, length: u32 },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    actor: u32,
    updates: Vec<Vec<u8>>,
    #[serde(default)]
    operations: Vec<Operation>,
    remote_state_vector: Option<Vec<u8>>,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let req: Request = serde_json::from_str(&input)?;
    let doc = TextReplica::new(req.actor);
    for update in req.updates {
        doc.apply(&update)?;
    }
    let before = doc.state_vector();
    for op in req.operations {
        match op {
            Operation::Insert { index, text } => doc.insert(index, &text)?,
            Operation::Delete { index, length } => doc.delete(index, length)?,
        }
    }
    let diff = doc.changes_since(req.remote_state_vector.as_deref().unwrap_or(&before))?;
    println!(
        "{}",
        json!({
            "text": doc.text(), "snapshot": doc.snapshot(),
            "state_vector": doc.state_vector(), "diff": diff,
        })
    );
    Ok(())
}
