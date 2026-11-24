# H1E console access

Current status at **12 October 2026, 23:19 UTC**: the everyday H1E runs custom **393988 /6.3.4_restore001** after the frozen image was flashed and automatically rebooted at 22:33:37 UTC. Same-device identity/capability/idle/card readbacks confirm operation, not a full installed-image SHA attestation. The current app transfer-contract run passed on 393988: 586-entry catalog/paging, bounded reads, owned-fixture match and exact 2,027,676-byte SHA-matched download. The 25-item ledger is **5 verified (A06, I01, I03, I04, P06), 15 in progress, 5 open**; P07 remains partial. See [flash evidence](../../research/rea/completion630-lab/runtime/current-custom393988-flash.json), [transfer evidence](../../research/rea/completion630-lab/runtime/current-transfer-contracts-1791844924345.json), [active iteration plan](active-iteration-plan.md) and [completion checklist](completion-checklist.md). Development/console delivery is the current target; installer/release qualification is parked.


The audit candidate adds a bounded USB status bridge, command `0xf117`, through the existing Jensen owner. It accepts exactly `help`, `version` or `uptime`, without a newline, terminator, extra arguments or arbitrary shell command. The application SDK requires exact custom H1E393986/6.3.2 or 393988/6.3.4 and a fresh REA1 capability reply before sending it. Official393984/6.3.0 and forward-stock393987/6.3.3 or393989/6.3.5 return unavailable without issuing this command. Higher version alone does not imply bridge support.

Programmatic access from the trusted app window:

```js
await window.electronAPI.jensen.getFirmwareConsoleStatus('help')
await window.electronAPI.jensen.getFirmwareConsoleStatus('version')
await window.electronAPI.jensen.getFirmwareConsoleStatus('uptime')
```

The result reports the supported commands, kernel/build version fields, or a 32-bit millisecond uptime counter. Uptime wraps after approximately 49.7 days. `imageAttested: false` is deliberate: a returned version string cannot prove the complete installed image hash. The firmware version field is the candidate's compiled literal.

The bounded bridge was physically exercised on the prior installed upload 2 **393986 / 6.3.2**. Real help/version/uptime replies matched the contract; kernel 1.9.0 and firmware literal 6.3.2 were returned, and two uptime reads advanced 298 ms. This qualifies I04 for those three USB status requests. The earlier stock gate correctly returned null with zero added USB events and remains historical. SDK 601 tests in 44 Vitest suites/17 files support host contracts; they are not physical console sessions. Arbitrary shell commands, UART pads/voltage/baud,64 callbacks/three built-ins and all 75 compiled selector cases remain physically unqualified. The 393988 bridge expects compiled literal6.3.4; its physical help/version/uptime replies have not yet been exercised after flash, and `imageAttested:false` remains explicit. [Prior physical console result](../../research/rea/completion630-lab/runtime/upload2-postboot-console-catalogue.json), [current transfer report](../../research/rea/completion630-lab/runtime/current-transfer-contracts-1791844924345.json), [historical stock gate](../../research/rea/completion630-lab/runtime/stock-console-gate.json).

See the [SDK contract and evidence](../../research/rea/completion630-lab/protocol/CONSOLE-STATUS-CONTRACT.md), [firmware repair report](../../research/rea/completion630-lab/firmware/REPORT-FIRMWARE-REPAIRS.md), [44-command map](command-map630.md) and [completion checklist](completion-checklist.md).


Historical pre-flash packaged-current 393986 smoke at 18:11 UTC again returned help with no f119 dispatch or device write. That package had the 6.3.4 literal/session parser support; it did not exercise the now-installed 393988 physical console. [Packaged smoke](../../research/rea/completion630-lab/runtime/restore4-package-current-custom-smoke.json).


The original compiled console binds UART_0. Its descriptor supplies default baud3,000,000 at configuration+8 and register base0xc0190000; initialization uses that default only when runtime baud is zero. Physical pads, voltage, board pinmux and observed effective baud remain unqualified. This is separate from the three-command USB bridge. [Exact compiled access evidence](../../research/rea/access-transfer630-lab/access/REPORT-ACCESS-PATHS.md).



