# Community migration notes

HiDock Next 2.0 was extracted from the original multi-application repository. Before the split, open issues and pull requests were reviewed so useful community work would not be lost.

## Included in 2.0

- Calendar grouping uses local calendar dates instead of UTC day keys. Thanks to [@toruhashimoto](https://github.com/toruhashimoto), original PR [#79](https://github.com/sgeraldes/hidock-next/pull/79).
- H1 devices using product ID `0xB00C` are recognized. Thanks to [@gausin3](https://github.com/gausin3), original PR [#82](https://github.com/sgeraldes/hidock-next/pull/82).
- P1 version-5 recording duration uses the observed 96 kbps stream rate, based on detailed hardware findings from [@fjbravo](https://github.com/fjbravo) in issue [#24](https://github.com/sgeraldes/hidock-next/issues/24).

## Roadmap or further validation

- Internationalization: issue [#53](https://github.com/sgeraldes/hidock-next/issues/53) contains a strong `react-i18next` proposal and a Japanese translation offer. This deserves a staged implementation after the 2.0 release rather than a rushed string extraction.
- P1/macOS access: issue [#24](https://github.com/sgeraldes/hidock-next/issues/24) documents macOS kernel-driver permissions and first-command timing. Those findings remain valuable, but transport changes require mock coverage and one controlled hardware validation before release.
- Local AI provider errors: issue [#49](https://github.com/sgeraldes/hidock-next/issues/49) reports LM Studio being treated as if it required a hosted-provider API key in the legacy Python app. Provider validation in 2.0 must remain provider-specific.

## Not imported

Closed PRs that introduced cloud-sync bridges or broad relay schemas were not imported. They add new credential, privacy, and data-model commitments and need a separately reviewed design.

