# F1: fail closed for unqualified experimental firmware

Date: 2026-10-12. Scope: apps/electron only. No hardware, no app build, no jensen-handlers.ts edit.

## Changes

- `electron/main/services/firmware-install.ts`
  - New dependency flags `qualificationEnabled` and `stockRecoveryEnabled`. Absent means false.
  - `prepare` and `execute` call `requireQualification()` as their first step inside `serialize`, before the journal, the image read or any device call.
  - `stock-forward` calls `requireStockRecovery()` at `prepare`. At `execute` it is checked from the saved plan's target version, so a saved stock-forward token is refused when the policy is off.
  - `status` and `observe` are unchanged: they stay read-only and usable for unresolved attempts.
- `electron/main/recovery-mode.ts`: new `isFirmwareStockRecoveryLaunch()`. It requires `isFirmwareQualificationLaunch()` and an explicit `--firmware-stock-recovery`.
- `electron/main/services/__tests__/firmware-install.test.ts`: fixture sets `qualificationEnabled: true`, the stock-forward test sets `stockRecoveryEnabled: true`, plus a new block of 9 zero-I/O policy tests.
- `electron/main/__tests__/recovery-mode.test.ts` (new): 9 launch-flag tests.

## Integration still needed (root)

`electron/main/ipc/jensen-handlers.ts:369` builds `FirmwareInstallService` without the new flags. Until root passes `qualificationEnabled: isFirmwareQualificationLaunch()` and `stockRecoveryEnabled: isFirmwareStockRecoveryLaunch()`, prepare and execute reject in every launch, including the authorized qualification one.

## Source SHA-256

| File | SHA-256 |
|---|---|
| electron/main/services/firmware-install.ts | 7f0467d6f125e4ec4d5a5ec5804e284573070df5957679bc01da60ec64f236d7 |
| electron/main/recovery-mode.ts | a1e3cf7644d00c1e2c5b754147ea3a23374cde484d725e26af2f9fc529ae067c |
| electron/main/services/__tests__/firmware-install.test.ts | 7bd75c652502402947bc106a91cdad2e801db04863ec91083addfe8d5cbe90fb |
| electron/main/__tests__/recovery-mode.test.ts | 55a1d7bddea5f76229039bab964ac96ff4ef3ad98eddf0c200136ae45952a94e |

## Results

`npx vitest run` on firmware-install.test.ts, recovery-mode.test.ts and recovery-startup.test.ts:

```
Test Files  3 passed (3)
     Tests  31 passed (31)
```

`npm run typecheck:node` (tsc --noEmit -p tsconfig.node.json): exit 0, no diagnostics.

Not run: web typecheck, full suite, app build, any hardware path.
