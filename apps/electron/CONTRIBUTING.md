# Contributing to HiDock Next

Thank you for helping improve HiDock Next 2.0.

## Before opening a change

- Search existing issues and pull requests.
- Keep changes focused and explain the user-visible behavior.
- Never commit API keys, tokens, recordings, transcripts, databases, logs, or other personal data.
- Do not probe a physical HiDock device while developing. USB changes must be covered by mocks first and tested on hardware only through the project's documented single-connection procedure.

## Local setup

From the repository root:

```bash
npm --prefix apps/electron ci
npm run typecheck
npm run lint
npm test
npm run build
```

The application is built with Electron, React, and TypeScript. Shared packages live in `packages/`.

## Pull requests

Include:

- a concise problem statement;
- the behavior before and after the change;
- tests or validation evidence;
- screenshots for visible UI changes; and
- any compatibility or migration impact.

By contributing, you agree that your contribution is licensed under the repository's MIT License.
