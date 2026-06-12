# ADR 0002: Desktop Release Identity

## Status

Accepted

## Context

Zorid needs a stable desktop application identity before the first tagged desktop release. The project owns the domain `zorid.app`, and Electron packaging already used `app.zorid.desktop` as the desktop app ID.

Changing a desktop app ID after distributing builds can disrupt signing identity, operating-system app metadata, preferences, update history, and user trust prompts.

## Decision

Use `app.zorid.desktop` as the canonical desktop app ID for release builds.

## Drivers

- The ID aligns with the owned `zorid.app` domain when reversed.
- The ID is already present in the desktop packaging configuration.
- The first tagged release should establish one stable identity before artifacts are distributed.

## Alternatives Considered

- `com.zorid.desktop`: conventional reverse-DNS style, but not aligned with the owned `zorid.app` domain.
- Change later: avoids deciding now, but increases migration and trust risk once artifacts exist.

## Consequences

- Desktop packaging, signing, notarization, and future update metadata should preserve `app.zorid.desktop`.
- Changing the app ID later requires an explicit migration decision.
