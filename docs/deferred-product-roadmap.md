# Product discussions after the editor foundation

Later steering on 2026-10-16 explicitly opens discussion of app-managed syncable
plugin data, secret storage, and a native mobile shell around the web editor.
The user then said to discuss first and **not change the API design now**.
No storage/sync/secret/mobile API design or runtime replacement is approved by
that discussion. Obsidian plugin API compatibility is no longer required.
The original calendar/task integrations below remain deferred.

User direction recorded 2026-10-16: discuss the following only after the editor
base is solid. These are deferred requirements, not approved architecture or
current implementation claims. Continue editor behavior, split views and
verification first; the later discussion exception above supersedes the earlier
discussion restriction only for the explicitly raised architecture topics.

- **Default Zorid sync:** use [Obsidian LiveSync](https://github.com/vrtmrz/obsidian-livesync)
  as the requested model, with setup that is very easy for users.
- **Built-in calendar:** use [FullCalendar](https://fullcalendar.io/).
- **Integrated tasks and calendar capabilities:** use
  [TaskNotes](https://github.com/callumalpass/tasknotes) as the requested capability
  reference, including tasks, two-way Google Calendar sync, task Kanban views,
  and broader task/calendar functionality to discuss at that stage.

These links record the user's references. Their APIs, licenses, compatibility,
deployment needs and feature boundaries have not yet been assessed for this work.
