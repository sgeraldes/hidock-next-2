# Install H1E custom firmware with HiDock Next

**HiDock H1E only. Sebastián Geraldes's unofficial custom firmware, based on official H1E 6.3.0.** The current installation target is **6.3.4 / 393988**. The 6.3.2 image is an archive, not a rollback target.

## Compatible Next revision

Use the public [HiDock Next firmware branch](https://github.com/sgeraldes/hidock-next-2/tree/firmware/h1e-6.3.4), at reviewed audio-control source commit **[be421bbd82d1e4544af60b25b8b4b2cb8e9ce589](https://github.com/sgeraldes/hidock-next-2/commit/be421bbd82d1e4544af60b25b8b4b2cb8e9ce589)**. Ordinary Next releases do not have a custom-firmware picker. This branch provides the installation API through Next's own USB connection; it is not a Windows installer or a separate USB flasher.

The exact same pinned image is included at `apps/electron/resources/firmware/h1e-rea-hardened.bin`. The separate [public firmware repository](https://github.com/sgeraldes/hidock-h1e-firmware) contains downloadable images and firmware documents; application source stays in this Next repository.

## Build the development application on Windows

Node.js 22.12 or later and Git are required. In PowerShell, create a separate checkout:

```powershell
git clone --single-branch --branch firmware/h1e-6.3.4 https://github.com/sgeraldes/hidock-next-2.git HiDockNext-H1E-Firmware
Set-Location HiDockNext-H1E-Firmware
git checkout be421bbd82d1e4544af60b25b8b4b2cb8e9ce589

$packages = @('ai-providers', 'calendar-sync', 'connectors', 'connectors-slack', 'database', 'jensen-protocol', 'knowledge-graph', 'transcription')
foreach ($package in $packages) {
    Push-Location (Join-Path 'packages' $package)
    try {
        npm.cmd ci --ignore-scripts
        if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed: $package" }
        npm.cmd run build --if-present
        if ($LASTEXITCODE -ne 0) { throw "Package build failed: $package" }
    } finally { Pop-Location }
}
npm.cmd --prefix apps/electron ci
if ($LASTEXITCODE -ne 0) { throw 'Next dependency installation failed' }
npm.cmd --prefix apps/electron run build
if ($LASTEXITCODE -ne 0) { throw 'Next build failed' }
```

These build the development app. Do not run `build:win` or an installer to use this procedure.

Check the bundled image before opening Next:

```powershell
(Get-Item apps/electron/resources/firmware/h1e-rea-hardened.bin).Length
(Get-FileHash apps/electron/resources/firmware/h1e-rea-hardened.bin -Algorithm SHA256).Hash
```

Required values: **3429376 bytes**, SHA-256 **4942c98f9a150f09b9a31b606e7e9d985e99b16873c5ef64e6e17667808d82e8**. The app independently checks these values and the firmware container before accepting an attempt.

## Launch with a dedicated, persistent profile

Close other HiDock applications and browser tabs that own the dock. Stop any recording or live capture you started and finish active transfers. Keep the normal dock power and USB connection in place.

Run the development app with both explicit flags. Keep the same profile folder for the whole attempt, including after an interrupted app session:

```powershell
Set-Location apps/electron
$firmwareProfile = Join-Path $env:LOCALAPPDATA 'HiDockNext-H1E-Firmware'
$firmwareLibrary = Join-Path $firmwareProfile 'library'
$firmwareConfigPath = Join-Path $firmwareProfile 'config.json'
New-Item -ItemType Directory -Path $firmwareProfile -Force | Out-Null
if (!(Test-Path -LiteralPath $firmwareConfigPath)) {
    $firmwareInitialConfig = @{ storage = @{ dataPath = $firmwareLibrary }; device = @{ autoConnect = $false };
       transcription = @{ autoTranscribe = $false } } |
        ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText($firmwareConfigPath, $firmwareInitialConfig, [Text.UTF8Encoding]::new($false))
}
$firmwareConfig = Get-Content -LiteralPath $firmwareConfigPath -Raw | ConvertFrom-Json
if ($firmwareConfig.storage.dataPath -ne $firmwareLibrary) {
    throw 'This profile points to another library. Use a new dedicated profile; do not overwrite its configuration.'
}
$previousProfile = $env:HIDOCK_DEV_USERDATA
$previousNodeMode = $env:ELECTRON_RUN_AS_NODE
try {
    $env:HIDOCK_DEV_USERDATA = $firmwareProfile
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    & .\node_modules\.bin\electron.cmd . --recovery-mode --firmware-qualification
} finally {
    if ($null -eq $previousProfile) { Remove-Item Env:HIDOCK_DEV_USERDATA -ErrorAction SilentlyContinue }
    else { $env:HIDOCK_DEV_USERDATA = $previousProfile }
    if ($null -eq $previousNodeMode) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
    else { $env:ELECTRON_RUN_AS_NODE = $previousNodeMode }
}
```

Recovery containment disables background scans, downloads, transcription, connectors and other automatic work for this launch. It does not rewrite the normal profile's saved settings. The firmware qualification flag explicitly enables the firmware owner APIs. No unauthenticated browser debugging port is opened automatically in this mode.

The profile and library are separate settings. `HIDOCK_DEV_USERDATA` alone does **not** isolate the recording library: without `storage.dataPath`, Next defaults to the normal `HiDock` folder. The configuration above pins a dedicated library and preserves any existing configuration instead of overwriting it. Keep both paths for the entire attempt.

## Prepare, review, execute, observe

Press **F12** in this development Next window to open its DevTools, then choose **Console**. Use this window's own API:

```javascript
const j = window.electronAPI.jensen;
await j.connect();
const device = await j.getDeviceInfo();
device;
const ready = await j.getFirmwareUpdatePreflight();
ready;
```

Confirm `device.model` is `hidock-h1e`, the reported version is the one expected, `ready.activeRecording` is `false`, and the card has status **2304 / 0x900** and at least **6 MiB free**. A `null` readiness result during connection startup is not permission to upload: allow the initial handshake to finish and repeat only the read-only preflight query. Do not prepare or execute while readiness is missing.

If the dock already reports **6.3.4 / 393988**, installation is unnecessary; this branch rejects reinstalling the same image. It also rejects downgrades. The firmware family was developed on official H1E 6.3.0 and the preceding custom 6.3.2, not on other HiDock models.

Prepare one attempt:

```javascript
const attempt = await j.prepareFirmwareInstall('hardened');
attempt;
```

Preparation reads the device and image and persists a prepared plan. It does not send the firmware. Review `attempt.state === 'prepared'` and its plan:

- `targetVersion`: **393988**.
- `imageBytes`: **3429376**.
- `imageSha256`: **4942c98f9a150f09b9a31b606e7e9d985e99b16873c5ef64e6e17667808d82e8**.
- `sourceVersion`: your current dock version.
- `id`: the attempt to retain; plans expire after five minutes.

Only after reviewing that exact plan, execute it **once**:

```javascript
const transfer = await j.executeFirmwareInstall(
    attempt.plan.id,
    '4942c98f9a150f09b9a31b606e7e9d985e99b16873c5ef64e6e17667808d82e8'
);
transfer;
```

The updater uses Next's existing serialized USB owner. It records the request durably before transmission and does not automatically retry. **The dock reboots automatically. Do not manually reset it, unplug power or start another upload.**

Observe the same attempt after the automatic reboot:

```javascript
const installed = await j.observeFirmwareInstall(attempt.plan.id);
installed;
```

A `confirmed` state requires the same device identity, exact target version, expected custom capabilities, idle recording state and ready card readback. The observation can wait up to three minutes. It does not attest a hash of every installed flash byte.

## Interrupted or uncertain attempts

Preserve the dedicated profile. Reopen this same revision with the same flags and profile, then inspect:

```javascript
const attempts = await j.getFirmwareInstallAttempts();
attempts;
```

For an existing `requesting`, `awaiting-boot` or `uncertain` attempt, use `observeFirmwareInstall(existingAttempt.plan.id)`. Observation reconnects and reads the dock; it does not upload firmware or send a reset. An unresolved or unreadable journal fences further writes. Do not delete that journal or create a second attempt to bypass uncertainty.

This branch installs only the pinned 6.3.4 image. It supplies no generic 6.3.0 restore, stock-forward recovery image or boot-ROM/unbrick procedure. Storage Optimize erases the recording card; it is not firmware recovery.

## Validation scope

The firmware-install implementation was qualified at source commit `cdc36e3`: its trusted API returned card/idle readiness and rejected an equal-version installation without creating an attempt or sending firmware. Initial preflight was unavailable while connection initialization was still in progress; the subsequent read-only query passed after that handshake completed. The pinned `be421bb` source retains that installation implementation and adds native controls and live monitoring. Its corrected Monitor/Stop path passed against the physical H1E already running 393988; see the [runtime receipt](evidence/h1e-native-live-393988.json).

The frozen 6.3.4 image had previously been uploaded through the same Next owner/update implementation and booted automatically. No additional flash was performed merely to validate this source publication. See the firmware repository's [validation record](https://github.com/sgeraldes/hidock-h1e-firmware/blob/main/VALIDATION.md) for the image, audio and marker evidence and its limits. To use native recording controls and the live channel monitor after installation, see [H1E native/live audio](h1e-native-live-audio.md); those controls use a normal app launch.
