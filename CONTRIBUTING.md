# Contributing to LineSync

Thanks for contributing.

---

## Requirements

- Node.js 18+
- npm 9+

---

## Setup

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

## Run Extension Locally

1. Open repository root in VS Code.
2. Go to **Run and Debug** (`Ctrl+Shift+D` / `Cmd+Shift+D`).
3. Run **LineSync: Run Extension**.
4. A second VS Code window opens with extension development host.

Tip: run two extension windows side by side for host/peer flow testing.

---

## Pull Requests

- Keep scope focused.
- Update docs for user-visible behavior changes.
- Add tests for non-trivial protocol/reliability changes.

### PR template

```md
## Summary
What changed and why.

## Test plan
Commands run, manual steps, edge cases checked.

## Notes (optional)
Risks, follow-ups, screenshots.
```

---

## Code Style

- TypeScript strict mode is required.
- Keep relay dependencies minimal.
- Validate all external input.
