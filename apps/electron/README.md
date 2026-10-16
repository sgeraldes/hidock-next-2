# HiDock Next desktop app

This directory contains the Electron application for HiDock Next 2.0.

```bash
npm ci
npm run dev
npm run typecheck
npm run lint
npm run test:run
npm run build
```

The required shared packages live in `../../packages`. See the [repository README](../../README.md) for downloads, screenshots, and privacy notes.

## Device integration

Use the [device guide](../../docs/devices/README.md) and [Jensen protocol reference](../../docs/devices/protocol.md) for model/version support and the application's serialized USB connection. Stored native MP3, Jensen realtime PCM and [PC stereo WebM capture](../../docs/pc-meeting-recorder.md) are distinct paths. Stock H1E6.3.0 software add-now markers have observed final-file persistence; custom stereo/profiles/gain firmware passes offline execution but remains uninstalled. Its explicit profile/WAV/rule APIs fail closed on stock firmware. [Build and remaining qualification](../../research/rea/REPORT-H1E-6.3.0-RECORDING-BUILD.md).

Native `HiDockVM` timestamp markers are separate from transcript-derived action/decision markers. The [local marker-copy tool](../../research/rea/native_markers.py) was verified through MP3 copying and decoding; native marker import/display in the app remains unimplemented.

