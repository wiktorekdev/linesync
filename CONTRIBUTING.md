# Contributing to LineSync

Thanks for taking the time to contribute. This document covers how to set up your development environment, run the project locally, and submit changes.

---

## Requirements

- Node.js 18+
- npm 9+

---

## Setup

Clone the repository:

```bash
git clone https://github.com/wiktorekdev/linesync
cd linesync
```

### Relay

```bash
cd relay
npm install
npm run dev
```

### Extension

```bash
cd extension
npm install
npm run compile
npm run package
```

---

## Running the Extension Locally

1. Open the repo root in VS Code.
2. Go to **Run and Debug** (`Ctrl+Shift+D` / `Cmd+Shift+D`).
3. Select and run **"LineSync: Run Extension"**.
4. A second VS Code window will open with the extension loaded in development mode.

> **Tip:** Launch two extension windows side-by-side to test a full host/guest session locally without needing a second machine.

---

## Submitting a Pull Request

- Keep changes focused. One concern per PR.
- Update documentation if your change affects user-visible behavior.
- Add tests for non-trivial logic, especially anything touching the protocol or merge behavior.

### PR description template

```
## Summary
What changed and why.

## Test plan
How you tested it — commands run, manual steps, edge cases checked.

## Notes (optional)
Risks, follow-ups, screenshots.
```

---

## Code Style

- **TypeScript:** strict mode enabled; use explicit types in all public APIs.
- **Relay:** keep dependencies minimal — the relay is designed to be lightweight and easy to self-host.
