# Connectors

How HiDock talks to external systems (Microsoft 365, Slack). The code cites this file as
"CONNECTORS.md".

## Layers

1. **Connector packages** (`packages/connectors-slack`, and the Microsoft 365 connector in
   `apps/electron/electron/main/services/connectors/m365`). Each talks to one external system and
   maps what it returns into HiDock entities (meetings, contacts, artifacts). Connectors call no
   language model.
2. **Host** (`packages/connectors`, `ConnectorHost` in `registry.ts`). Registers connector types,
   builds one instance per account, and owns everything that must survive a restart: config,
   encrypted secrets, status, per-source state (on/off, cursor, last sync). Electron persists it in
   `connectors.json` through `connector-store.ts`.
3. **Ingestion** (`apps/electron/electron/main/services/connectors/ingestion.ts`). Writes what a
   sync pulled into the database. Connector meetings get ids `<instanceId>:<externalId>`.

## Rules the host relies on

- **The instance id is the connector's id, for its whole life** (`ctx.connectorId`: `m365`,
  `m365:<uuid>`, `slack`). A connector never derives its id from a credential.
- **New credentials are a new account.** When a secret field changes, the host restarts every
  source's cursor and keeps each source's on/off choice. Connectors re-read their credentials on
  `configure()` and `connect()`, and drop work that started under the old ones.
- **Sources start as the connector says.** `SourceContainer.defaultEnabled` (default true) applies
  until the user chooses; Slack channels start off. The host checks `hasSourceState` before
  falling back to the default, and the Settings UI uses the same fallback.
- **A sync can stop early.** One sync reads at most 50 pages per source and saves the next page's
  cursor. It then reports `truncated: true`; a caller that needs the whole source (for example
  Relink recordings to meetings) syncs again until it is false.
- **Identity confidence.** 1.0 means the connector confirmed the identity (an email match); 0.5 a
  name-only association.

## Microsoft 365

- HiDock ships its own public client registration, "HiDock Next (Desktop)"; a user's own
  registration can replace it under Advanced.
- Delegated scopes: User.Read, Calendars.Read, Contacts.Read, People.Read, User.ReadBasic.All.
- The calendar reads the last 30 days and the next 120. `calendarHistoryStart` (set by Relink)
  reaches further back.

## Slack

- A bot or user token (`xoxb-` or `xoxp-`), stored encrypted.
- Channels are picked per source in Settings; nothing syncs until one is on.
