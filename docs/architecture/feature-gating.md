# Feature gating: what the main process enforces and what the window must know

The registry is `apps/electron/src/shared/feature-registry.ts`; the main-process gate is
`apps/electron/electron/main/services/feature-gate.ts`. This page records the contract between the
two processes. (The registry used to point at `docs/specs/2026-07-11-modular-features-spec.md`,
which was never in this repository.)

## Two kinds of feature

- **Runtime-toggleable** (transcription, calendar, meeting intelligence, the connectors): the gate
  reads the live config on every call. Turning one off or on takes effect at once.
- **Restart-gated** (`runtimeToggleable: false`: Device Sync and Assistant): the gate works from a
  snapshot taken at boot (`captureBootEffectiveFeatures`), before any IPC handler registers.

For a restart-gated feature:

| At boot | Now | Initiation channels | Teardown / observation channels |
|---|---|---|---|
| on | on | open | open |
| on | turned off | closed | open, so in-flight work can drain |
| off | anything | closed until the next launch | closed until the next launch |

Initiation and teardown channels are listed in the registry (`TEARDOWN_CHANNELS`); everything else
owned by the feature is initiation.

## What the window is told at launch

Main passes the restart-gated features that were off at boot to the window when it creates it:
`BrowserWindow` `additionalArguments` carries `--hidock-boot-disabled-features=<id,id>`, the preload
reads it from `process.argv` and exposes `window.electronAPI.bootDisabledFeatures`. The renderer
reads it through `isFeatureOffThisRun(id)` (`src/lib/bootFeatures.ts`). It is known from the first
render, before the config store loads, and it does not change during the run.

Rules for renderer code that calls a restart-gated feature's channels:

- Code that runs on its own (at mount, on a timer, on an event) checks
  `isFeatureOffThisRun(id)` first and does nothing when it is true. Every one of those channels
  rejects until the next launch, and each rejection is logged in the main process.
- Hooks that exist only to serve the feature are not mounted when it is off this run
  (`OperationController` renders `DeviceOperations` only then). A live disable keeps them
  mounted: they drain in-flight work through the teardown channels.
- A read whose result only adds to a view (the device cache in the Library) treats the gate's
  rejection as "nothing to add" (`isFeatureDisabledRejection`, `src/lib/featureDisabled.ts`), so a
  feature being off never empties the view.
- Code the owner starts by hand on a page that is itself route-gated needs no extra check.

The config store's resolved state (`useFeatureStore`) is still the source for what the Settings
page shows and for live toggles; it defaults to "everything on" until config loads, which is why
it is not enough for calls made at startup.
