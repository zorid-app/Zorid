use super::*;
use zorid_client_sync::{
    AuthenticatedText, ReceiveCursor, ReceiveRequest, TextIdentity, TextState,
};
use zorid_crypto::VaultKey;
use zorid_sync_protocol::{ExpectedContext, RealmId, UpdateId, VaultId};
impl NativeVault {
    pub fn text_state(&self, id: &EntryId) -> Result<Option<TextState>> {
        self.paths.verify()?;
        Ok(self.store.text_state(id)?)
    }
    pub fn bind_empty_text(
        &mut self,
        identity: &TextIdentity,
        expected: &Revision,
    ) -> Result<TextState> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        Ok(self.store.bind_empty_text(identity, expected)?)
    }
    /// Explicit adoption is an authored, conditional existing-file command. It
    /// must name exact committed bytes and never infers identity from the path.
    pub fn adopt_text(
        &mut self,
        identity: &TextIdentity,
        request: &MutationRequest,
    ) -> Result<ApplyOutcome> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        let commit = self.store.adopt_text(identity, request)?;
        let projection = self.project_status(&identity.entry_id);
        Ok(ApplyOutcome { commit, projection })
    }
    /// Receive does not import observed filesystem bytes or construct a local
    /// command. Its DB receipt precedes any attempted physical publication.
    pub fn receive_text(
        &mut self,
        authenticated: &AuthenticatedText,
        request: &ReceiveRequest,
    ) -> Result<ReceiveOutcome> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        let commit = self.store.receive_text(authenticated, request)?;
        self.point("received_committed");
        let projection = self.project_status(&commit.identity.entry_id);
        Ok(ReceiveOutcome { commit, projection })
    }
    pub fn text_receive_cursor(
        &self,
        realm: &RealmId,
        vault: &VaultId,
    ) -> Result<Option<ReceiveCursor>> {
        self.paths.verify()?;
        Ok(self.store.text_receive_cursor(realm, vault)?)
    }
    pub fn set_text_receive_cursor(
        &mut self,
        expected: Option<&ReceiveCursor>,
        next: &ReceiveCursor,
    ) -> Result<()> {
        let _guard = self.paths.lock(self.options.lock_timeout)?;
        self.paths.verify()?;
        Ok(self.store.set_text_receive_cursor(expected, next)?)
    }
    pub fn seal_authored_text(
        &mut self,
        expected: &ExpectedContext,
        key: &VaultKey,
    ) -> Result<Vec<u8>> {
        self.paths.verify()?;
        Ok(self.store.seal_authored_text(expected, key)?)
    }
    pub fn pending_authored_text(
        &self,
        after: Option<&UpdateId>,
        limit: u32,
    ) -> Result<Vec<AuthoredTextStatus>> {
        self.paths.verify()?;
        Ok(self.store.pending_authored_text(after, limit)?)
    }
    pub fn acknowledge_authored_text(
        &mut self,
        realm: &RealmId,
        vault: &VaultId,
        update: &UpdateId,
        wire: &[u8],
    ) -> Result<()> {
        self.paths.verify()?;
        Ok(self
            .store
            .acknowledge_authored_text(realm, vault, update, wire)?)
    }
}
