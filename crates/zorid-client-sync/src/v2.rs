//! Namespace-aware text protocol. Legacy v1 APIs stay separate and never mint
//! namespace activity. Hosts commit this text plan and the file graph plan in one
//! transaction; neither an activity nor a text plan alone authorizes publication.
use super::*;
use zorid_core::VaultPath;

pub const TEXT_FORMAT_VERSION: u32 = 2;
pub const MAX_NAMESPACE_PARENTS: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextNamespaceContext {
    /// Namespace Create identity, independent of TextIdentity::bootstrap_id.
    pub bootstrap_id: UpdateId,
    /// Canonical observed namespace frontier. File graph validates ancestry,
    /// binding, admissibility and that these form an antichain.
    pub parents: Vec<UpdateId>,
}
impl TextNamespaceContext {
    fn validate(&self, update_id: &UpdateId) -> Result<()> {
        if self.parents.is_empty()
            || self.parents.len() > MAX_NAMESPACE_PARENTS
            || self.parents.windows(2).any(|pair| pair[0] >= pair[1])
            || self.parents.contains(update_id)
            || &self.bootstrap_id == update_id
        {
            return Err(SyncError::InvalidPayload);
        }
        Ok(())
    }
}

/// Physical path is an exact saved host witness, NOT a path reconstructed from
/// location_event. Ancestor moves can change paths without changing this event.
/// File graph checks location lineage; host checks saved inode/parent provenance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextPhysicalLocation {
    pub path: VaultPath,
    pub location_event: UpdateId,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextPhysicalBaseline {
    pub text: TextBaseline,
    pub namespace: TextNamespaceContext,
    pub location: TextPhysicalLocation,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Payload {
    family: String,
    format_version: u32,
    identity: TextIdentity,
    namespace: TextNamespaceContext,
    actor: ActorRegistration,
    update: Vec<u8>,
}
impl Payload {
    fn decode(bytes: &[u8], update_id: &UpdateId) -> Result<Self> {
        if bytes.len() > MAX_PLAINTEXT_BYTES {
            return Err(SyncError::TooLarge);
        }
        #[derive(Deserialize)]
        struct Discriminator {
            #[serde(default)]
            family: Option<String>,
            #[serde(default)]
            format_version: Option<u32>,
        }
        let tag: Discriminator =
            serde_json::from_slice(bytes).map_err(|_| SyncError::InvalidPayload)?;
        if tag.family.as_deref() != Some("text") || tag.format_version != Some(TEXT_FORMAT_VERSION)
        {
            return Err(SyncError::UnsupportedFormat);
        }
        let payload: Self = serde_json::from_slice(bytes).map_err(|_| SyncError::InvalidPayload)?;
        payload.namespace.validate(update_id)?;
        // Reuse the bounded CRDT framing check performed by v1; this internal
        // struct is not an old wire envelope or a public conversion capability.
        payload.text_payload().encode()?;
        Ok(payload)
    }
    fn text_payload(&self) -> TextPayload {
        TextPayload {
            family: "text".into(),
            format_version: super::TEXT_FORMAT_VERSION,
            identity: self.identity.clone(),
            actor: self.actor.clone(),
            update: self.update.clone(),
        }
    }
}

/// Unauthenticated payload metadata for validating stored local authored intents.
/// This is ordinary data, not evidence that an update was received, authorized,
/// or committed. It cannot create TextActivity or AuthenticatedText.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextPayloadMetadata {
    pub identity: TextIdentity,
    pub namespace: TextNamespaceContext,
}

/// Inspect bounded, strict current-format plaintext without authenticating it.
/// `update_id` is external framing context and is NOT proven by this function.
/// Hosts must independently compare exact persisted payload bytes/digest and all
/// intent metadata. Receive paths must instead use AuthenticatedText::from_opened.
/// Missing CRDT dependencies and content semantics are checked during planning;
/// this inspection checks payload framing, declared actor and namespace shape.
pub fn inspect_payload(bytes: &[u8], update_id: &UpdateId) -> Result<TextPayloadMetadata> {
    let payload = Payload::decode(bytes, update_id)?;
    Ok(TextPayloadMetadata {
        identity: payload.identity,
        namespace: payload.namespace,
    })
}

/// Only authenticated v2 decoding or successful local planning can construct
/// this evidence. It has no Deserialize, Clone or public raw constructor.
/// Namespace graph validation remains mandatory before committing either plan.
/// ```compile_fail
/// use zorid_client_sync::v2::TextActivity;
/// let forged: TextActivity = serde_json::from_str("{}").unwrap();
/// ```
pub struct TextActivity {
    identity: TextIdentity,
    update_id: UpdateId,
    namespace: TextNamespaceContext,
    payload_bytes: Vec<u8>,
}
impl TextActivity {
    pub fn identity(&self) -> &TextIdentity {
        &self.identity
    }
    pub fn update_id(&self) -> &UpdateId {
        &self.update_id
    }
    pub fn namespace(&self) -> &TextNamespaceContext {
        &self.namespace
    }
    pub fn payload_bytes(&self) -> &[u8] {
        &self.payload_bytes
    }
}

pub struct AuthenticatedText {
    inner: super::AuthenticatedText,
    activity: TextActivity,
}
impl AuthenticatedText {
    pub fn open(wire: &[u8], expected: &ExpectedContext, key: &VaultKey) -> Result<Self> {
        let opened = OpenedEnvelope::open(wire, expected, key)
            .map_err(|_| SyncError::AuthenticationFailed)?;
        Self::from_opened(&opened)
    }
    pub fn from_opened(opened: &OpenedEnvelope) -> Result<Self> {
        let header = opened.header();
        let payload = Payload::decode(opened.plaintext(), header.update_id())?;
        if &payload.identity.realm_id != header.realm_id()
            || &payload.identity.vault_id != header.vault_id()
        {
            return Err(SyncError::IdentityMismatch);
        }
        let record = ReceivedRecord {
            identity: payload.identity.clone(),
            update_id: header.update_id().clone(),
            exact_wire: opened.envelope().encode(),
        };
        let inner = super::AuthenticatedText {
            payload: payload.text_payload(),
            record,
        };
        Ok(Self {
            inner,
            activity: TextActivity {
                identity: payload.identity,
                update_id: header.update_id().clone(),
                namespace: payload.namespace,
                payload_bytes: opened.plaintext().to_vec(),
            },
        })
    }
    pub fn identity(&self) -> &TextIdentity {
        self.activity.identity()
    }
    pub fn update_id(&self) -> &UpdateId {
        self.activity.update_id()
    }
    pub fn activity(&self) -> &TextActivity {
        &self.activity
    }
}

/// Private wrapper ties activity to the exact successful plan. Deserializing the
/// legacy public AuthoredPlan cannot produce this wrapper or its capability.
pub struct AuthoredTextPlan {
    plan: AuthoredPlan,
    activity: TextActivity,
}
impl AuthoredTextPlan {
    pub fn plan(&self) -> &AuthoredPlan {
        &self.plan
    }
    pub fn activity(&self) -> &TextActivity {
        &self.activity
    }
    pub fn into_plan(self) -> AuthoredPlan {
        self.plan
    }
}
fn wrap(mut plan: AuthoredPlan, namespace: &TextNamespaceContext) -> Result<AuthoredTextPlan> {
    namespace.validate(&plan.authored.update_id)?;
    let old = TextPayload::decode(&plan.authored.payload_bytes)?;
    let payload = Payload {
        family: "text".into(),
        format_version: TEXT_FORMAT_VERSION,
        identity: old.identity,
        actor: old.actor,
        update: old.update,
        namespace: namespace.clone(),
    };
    let bytes = serde_json::to_vec(&payload).map_err(|_| SyncError::InvalidPayload)?;
    Payload::decode(&bytes, &plan.authored.update_id)?;
    plan.authored.payload_bytes = bytes.clone();
    let activity = TextActivity {
        identity: plan.authored.identity.clone(),
        update_id: plan.authored.update_id.clone(),
        namespace: namespace.clone(),
        payload_bytes: bytes,
    };
    Ok(AuthoredTextPlan { plan, activity })
}

pub fn plan_authored_text(
    state: &TextState,
    request: &AuthorRequest,
    namespace: &TextNamespaceContext,
) -> Result<AuthoredTextPlan> {
    namespace.validate(&request.update_id)?;
    wrap(super::plan_authored_text(state, request)?, namespace)
}
pub fn plan_replace_text(
    state: &TextState,
    desired_utf8: &[u8],
    request: &AuthorRequest,
    namespace: &TextNamespaceContext,
) -> Result<AuthoredTextPlan> {
    namespace.validate(&request.update_id)?;
    wrap(
        super::plan_replace_text(state, desired_utf8, request)?,
        namespace,
    )
}

pub struct ExternalTextPlan {
    authored: AuthoredTextPlan,
    expected_baseline: TextPhysicalBaseline,
    observed_baseline: TextPhysicalBaseline,
}
impl ExternalTextPlan {
    pub fn authored(&self) -> &AuthoredTextPlan {
        &self.authored
    }
    pub fn expected_baseline(&self) -> &TextPhysicalBaseline {
        &self.expected_baseline
    }
    pub fn observed_baseline(&self) -> &TextPhysicalBaseline {
        &self.observed_baseline
    }
    /// Check the ENTIRE physical witness inside the dual text/namespace commit.
    pub fn check_preconditions(
        &self,
        actual: &TextState,
        baseline: &TextPhysicalBaseline,
        update_id_unused: bool,
    ) -> Result<()> {
        if baseline != &self.expected_baseline {
            return Err(SyncError::InvalidState);
        }
        self.authored
            .plan
            .check_preconditions(actual, Some(&baseline.text), update_id_unused)
    }
}
pub fn plan_external_text_with_baseline(
    state: &TextState,
    baseline: &TextPhysicalBaseline,
    observed_utf8: &[u8],
    request: &AuthorRequest,
    observed_revision: &Revision,
) -> Result<ExternalTextPlan> {
    baseline.namespace.validate(&request.update_id)?;
    let result = super::plan_external_text_with_baseline(
        state,
        &baseline.text,
        observed_utf8,
        request,
        observed_revision,
    )?;
    let authored = wrap(result.authored, &baseline.namespace)?;
    let observed_baseline = TextPhysicalBaseline {
        text: result.observed_baseline,
        namespace: TextNamespaceContext {
            bootstrap_id: baseline.namespace.bootstrap_id.clone(),
            parents: vec![request.update_id.clone()],
        },
        location: baseline.location.clone(),
    };
    Ok(ExternalTextPlan {
        authored,
        expected_baseline: baseline.clone(),
        observed_baseline,
    })
}

/// Tombstones are intentionally absent from text state: merge retained causal
/// content without deciding visibility. The file plan alone determines whether
/// publication is live, recovery-only or deleted. Remote plans never author echo.
pub fn plan_received_text(
    state: &TextState,
    request: &ReceiveRequest,
    incoming: &AuthenticatedText,
    prior: Option<&ReceivedRecord>,
    cursor: Option<&ReceiveCursor>,
) -> Result<ReceivedPlan> {
    super::plan_received_text(state, request, &incoming.inner, prior, cursor)
}

#[cfg(test)]
mod tests;
