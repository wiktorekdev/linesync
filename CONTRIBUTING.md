# Contributing

Thanks for contributing to LineSync.

## Requirements
- Node.js 18+
- npm 9+

## Setup
```bash
git clone <repo>
cd linesync
```

Relay:
```bash
cd relay
npm install
npm run dev
```

Extension:
```bash
cd extension
npm install
npm run compile
npm run package
```

## Debug in VS Code (extension)
1. Open the repo in VS Code.
2. Go to Run and Debug.
3. Run "LineSync: Run Extension".
4. A second VS Code window will open with the extension loaded.

Tip: You can run two extension windows to test host/guest locally.

## Pull Requests
- Keep changes focused and small.
- Update docs when behavior changes.
- Prefer tests for non-trivial logic (protocol, merge logic).

### PR description template (copy/paste)

```
## Summary
- What changed and why

## Test plan
- How you tested it (commands, manual steps)

## Notes (optional)
- Risks, follow-ups, screenshots
```

## Code Style
- TypeScript: strict mode, explicit types in public APIs.
- Node: avoid heavy dependencies in the relay.
