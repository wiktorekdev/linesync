# LineSync

[![CI](https://img.shields.io/github/actions/workflow/status/wiktorekdev/linesync/ci.yml?branch=main&label=ci)](https://github.com/wiktorekdev/linesync/actions/workflows/ci.yml)
![License](https://img.shields.io/github/license/wiktorekdev/linesync?label=license)
![Stars](https://img.shields.io/github/stars/wiktorekdev/linesync?style=social)

Live file sync between VS Code instances. No commits, no branches, no merge ceremony.

LineSync is a lightweight collaboration layer on top of git. Use it for pairing,
mentoring, or quick sessions where "see my cursor and edits now" matters.

## Repo Layout
- `extension/` VS Code extension (TypeScript)
- `relay/` WebSocket relay (Node.js)

## Install (VSIX)
1. Download the latest `.vsix` from GitHub Releases.
2. In VS Code: Extensions -> "..." menu -> "Install from VSIX..."
3. Select the downloaded file.

To publish a release:
```bash
git tag v0.1.0
git push origin v0.1.0
```
The release workflow will build and attach the `.vsix`.

## 2-minute usage
1. On the host: run `LineSync: Start New Session`
   - Share the session code and password
   - Optionally copy the "join token" (includes password)
2. On the guest: run `LineSync: Join Session`
   - Paste the session code (or the join token)
   - Enter the password

## Quickstart (Local)
1. Relay
```bash
cd relay
npm install
npm run start
```

2. Extension (build)
```bash
cd extension
npm install
npm run compile
npm run package
```
Install the generated `.vsix` in VS Code.

## Configure
Set these in VS Code settings:
```json
{
  "linesync.relayUrl": "auto",
  "linesync.userName": "YourName",
  "linesync.mergePolicy": "prompt"
}
```

Key settings:
- `linesync.relayUrl` WebSocket URL of your relay (or `auto`)
- `linesync.relayUrls` Optional list of relays for auto-selection
- `linesync.userName` Display name shown to peers
- `linesync.mergePolicy` Conflict policy when auto-merge fails
- `linesync.relaySecret` Optional shared secret for the relay
- `linesync.maxFileSizeKB` Skip files larger than this
- `linesync.ignorePatterns` Exclude paths from sync (folders and globs)

## Public Relays (Default)
LineSync ships with three public relays and will auto-select the lowest-latency one:
- `wss://linesync-us.onrender.com` (US West)
- `wss://linesync-de.onrender.com` (Frankfurt, Germany)
- `wss://linesync-sg.onrender.com` (Singapore)

Health:

- US: [![relay-us](https://img.shields.io/website?label=relay-us&url=https%3A%2F%2Flinesync-us.onrender.com%2Fhealth)](https://linesync-us.onrender.com/health)
- DE: [![relay-de](https://img.shields.io/website?label=relay-de&url=https%3A%2F%2Flinesync-de.onrender.com%2Fhealth)](https://linesync-de.onrender.com/health)
- SG: [![relay-sg](https://img.shields.io/website?label=relay-sg&url=https%3A%2F%2Flinesync-sg.onrender.com%2Fhealth)](https://linesync-sg.onrender.com/health)

To force auto-selection explicitly:
```json
{
  "linesync.relayUrl": "auto",
  "linesync.relayUrls": [
    "wss://linesync-us.onrender.com",
    "wss://linesync-de.onrender.com",
    "wss://linesync-sg.onrender.com"
  ]
}
```

## Session code, password, and encryption
- Host shares the **session code** (example: `ABCDEF`).
- A session password is required and enables end-to-end encryption.

Tip: the host can also copy a **join token** `ABCDEF.PASSWORD` (includes the password). If you paste it into the code prompt, LineSync will auto-fill the password.

## Threat model (what is protected)
LineSync uses a relay server to connect peers. The relay is designed to be stateless for file data, but it still sees metadata.

What a public relay can see:
- Your IP address and basic connection metadata
- Message timing and approximate sizes
- Session codes (not the file contents when encryption is enabled)

Encryption details:
- File sync messages are encrypted with AES-GCM using a key derived from the session password.
- The relay enforces session access using a derived password hash (verifier). It does not need the raw password to route messages.
- A malicious relay could still try to guess weak passwords offline. Use a strong password.

Not protected:
- Metadata (timing, sizes) is not hidden by encryption.

## Relay close codes
These are the most common disconnect reasons from the relay:

| Code | Meaning |
|---:|---|
| 4001 | Wrong relay secret (`RELAY_SECRET`) |
| 4002 | Session full |
| 4003 | Wrong session password |
| 4004 | Password required |
| 4007 | Heartbeat timeout |
| 4008 | Rate limited (too many join attempts) |
| 4010 | Kicked / banned by host |
| 4011 | Banned from session |

## Limits and ignored files
- LineSync skips large files (see `linesync.maxFileSizeKB`).
- Binary and common generated files are skipped by default.
- Customize exclusions with `linesync.ignorePatterns`.

## License
MIT (see `LICENSE`)
