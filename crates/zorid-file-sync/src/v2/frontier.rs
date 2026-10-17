use super::*;

impl State {
    /// Join a previously published entry frontier with one same-entry Move,
    /// removing causally dominated heads and retaining incomparable history.
    ///
    /// This validates graph semantics, NOT filesystem application or historical
    /// publication. The adapter must supply its durable physical baseline and
    /// proof that this exact Move reached disk, then commit the returned frontier
    /// with its physical revision/path. It must not substitute current graph heads
    /// for `prior`, or infer that newer text bytes were physically published.
    ///
    /// An ancestor folder's Move cannot be joined into a descendant's frontier.
    /// The descendant retains its own frontier and needs separate journal proof
    /// of the ancestor/member relationship and actual path/parent inode. Restore
    /// is intentionally excluded: it needs its own materialization proof.
    pub fn join_physical_move_frontier(
        &self,
        identity: &EntryIdentity,
        prior: &[UpdateId],
        applied_move: &UpdateId,
    ) -> Result<Vec<UpdateId>> {
        if prior.is_empty() {
            return Err(Error::InvalidCausality);
        }
        if prior.len() > super::super::MAX_PARENTS {
            return Err(Error::TooLarge);
        }
        if prior.windows(2).any(|pair| pair[0] >= pair[1]) {
            return Err(Error::InvalidCausality);
        }
        let (_, graph) = self.view_and_ancestry()?;
        let moved = graph.resolved_event(applied_move)?;
        if moved.identity != *identity {
            return Err(Error::IdentityMismatch);
        }
        if !matches!(moved.effect, GraphEffect::Move { .. }) {
            return Err(Error::InvalidCausality);
        }
        for head in prior {
            if graph.resolved_event(head)?.identity != *identity {
                return Err(Error::IdentityMismatch);
            }
            for other in prior {
                if head != other && graph.is_ancestor(head, other)? {
                    return Err(Error::InvalidCausality);
                }
            }
        }
        let mut joined = prior.to_vec();
        match joined.binary_search(applied_move) {
            Ok(_) => {}
            Err(index) => joined.insert(index, applied_move.clone()),
        }
        let mut result = Vec::with_capacity(joined.len());
        for head in &joined {
            let mut dominated = false;
            for other in &joined {
                if head != other && graph.is_ancestor(head, other)? {
                    dominated = true;
                    break;
                }
            }
            if !dominated {
                result.push(head.clone());
            }
        }
        if result.len() > super::super::MAX_PARENTS {
            return Err(Error::TooLarge);
        }
        Ok(result)
    }
}
