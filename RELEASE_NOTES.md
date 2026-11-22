# HiDock Next 2.0.0

HiDock Next 2.0 is the first release from the focused Electron repository.

- Local-first recording library and knowledge workspace.
- HiDock device sync with serialized USB operations.
- Transcription, speaker identity, calendar correlation, projects, people, and action items.
- Pluggable hosted and local AI providers.
- Microsoft 365 and Slack connector foundations.
- Duration-aware acoustic speaker-linking budgets for long recordings, with graceful provider-diarization fallback.
- Community fixes for local calendar dates and H1 `0xB00C` hardware.
- Separate [HiDock Light](https://github.com/sgeraldes/hidock-light) repository for the Python device manager.

Device capabilities and research status are documented in [the device guide](docs/devices/README.md). The deployed stock H1E6.3.0 path supports provider-free paired capture, individual track export and programmatic add-now markers with one observed native MP3 footer. The full custom stereo/profiles/gain/WAV/default-off-rules image passes offline integrity and exact-image execution checks. It is uninstalled; physical qualification remains open. These development results do not constitute a modified-firmware release. [Current build evidence](research/rea/REPORT-H1E-6.3.0-RECORDING-BUILD.md).
