# LineSync

<div align="center">

**Premium live collaboration for VS Code - instant peer sync without branches or commits.**

[![CI](https://img.shields.io/github/actions/workflow/status/wiktorekdev/linesync/ci.yml?branch=main&label=ci&style=for-the-badge&logo=githubactions&logoColor=white)](https://github.com/wiktorekdev/linesync/actions/workflows/ci.yml)
![License](https://img.shields.io/github/license/wiktorekdev/linesync?label=license&style=for-the-badge&color=blue&logo=opensourceinitiative&logoColor=white)
![Stars](https://img.shields.io/github/stars/wiktorekdev/linesync?label=stars&style=for-the-badge&color=success&logo=github&logoColor=white)

[![relay-us](https://img.shields.io/website?label=relay-us&style=for-the-badge&url=https%3A%2F%2Flinesync-us.onrender.com%2Fhealth)](https://linesync-us.onrender.com/health)
[![relay-de](https://img.shields.io/website?label=relay-de&style=for-the-badge&url=https%3A%2F%2Flinesync-de.onrender.com%2Fhealth)](https://linesync-de.onrender.com/health)
[![relay-sg](https://img.shields.io/website?label=relay-sg&style=for-the-badge&url=https%3A%2F%2Flinesync-sg.onrender.com%2Fhealth)](https://linesync-sg.onrender.com/health)

</div>

---

LineSync is a lightweight real-time collaboration layer for pair programming, mentoring, and review sessions where shared context matters more than git ceremony.

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Relays](#relays)
- [Sessions and Encryption](#sessions-and-encryption)
- [Security](#security)
- [File Limits and Exclusions](#file-limits-and-exclusions)
- [License](#license)

---

## Installation

1. Download the latest `.vsix` from [GitHub Releases](https://github.com/wiktorekdev/linesync/releases).
2. Open VS Code -> **Extensions** -> click the `...` menu -> **Install from VSIX...**
3. Select the downloaded file and reload when prompted.

---

## Quick Start

**Host**
1. Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run `LineSync: Start Session`.
2. LineSync generates and copies a **session token**.
3. Share that token with your collaborator.

**Peer**
1. Run `LineSync: Join Session`.
2. Paste the session token.

You are live.

---

## Configuration

```json
{
  "linesync.relayUrl": "auto",
  "linesync.relayUrls": [
    "wss://linesync-us.onrender.com",
    "wss://linesync-de.onrender.com",
    "wss://linesync-sg.onrender.com"
  ],
  "linesync.relayProbeTimeoutMs": 1200,
  "linesync.relayProbeSamples": 3,
  "linesync.userName": "YourName",
  "linesync.peerMode": "edit",
  "linesync.relaySecret": "",
  "linesync.maxFileSizeKB": 512,
  "linesync.autoResyncOnDrift": true,
  "linesync.driftCheckIntervalMs": 2500,
  "linesync.autoResyncCooldownMs": 15000,
  "linesync.maxAutoResyncPerFile": 3,
  "linesync.ignorePatterns": []
}
```

| Setting | Description |
|---|---|
| `linesync.relayUrl` | WebSocket relay URL, or `"auto"` for relay auto-selection v2. |
| `linesync.relayUrls` | Relay candidates used when `relayUrl` is `"auto"`. |
| `linesync.relayProbeTimeoutMs` | Timeout per relay probe sample (ms). |
| `linesync.relayProbeSamples` | Number of probe samples per relay. |
| `linesync.userName` | Display name shown to peers. Empty value uses generated alias. |
| `linesync.peerMode` | Mode for joined peers: `edit` or `readOnly`. |
| `linesync.relaySecret` | Optional shared secret for private relays. |
| `linesync.maxFileSizeKB` | Live-sync size limit in KB. Larger files use snapshot flow. |
| `linesync.autoResyncOnDrift` | Auto-request safe snapshot when peer drift is detected. |
| `linesync.driftCheckIntervalMs` | Periodic drift detection interval in ms. |
| `linesync.autoResyncCooldownMs` | Minimum delay between auto-resync attempts per file. |
| `linesync.maxAutoResyncPerFile` | Max automatic resync attempts per file before manual action. |
| `linesync.ignorePatterns` | Additional glob/folder exclusions from sync and snapshots. |

---

## Relays

LineSync ships with three official relays across regions. With `relayUrl: "auto"`, LineSync ranks relay quality using latency samples and recent health history, then picks the best candidate.

| Region | URL |
|---|---|
| US West | `wss://linesync-us.onrender.com` |
| Frankfurt, Germany | `wss://linesync-de.onrender.com` |
| Singapore | `wss://linesync-sg.onrender.com` |

More relay info: [COMMUNITY_RELAYS.md](COMMUNITY_RELAYS.md)

---

## Sessions and Encryption

- A single opaque **session token** is used for sharing/joining.
- File payloads are encrypted end-to-end with AES-GCM.
- Relay only receives a verifier hash for authentication and cannot read file content.
- Official relay token TTL defaults to **7 days** (configurable on self-hosted relay).

Keep session tokens private. Anyone with the token can attempt to join.

---

## Security

The relay can observe metadata (IP, timing, message sizes, session identifiers) but cannot read encrypted file content.

For security reporting and scope, see [SECURITY.md](SECURITY.md).

---

## File Limits and Exclusions

- Files above `linesync.maxFileSizeKB` use snapshot transfer.
- Binary and generated artifacts are excluded by default.
- Add custom exclusions with `linesync.ignorePatterns`.
- Drift detection and conflict hints help recover safely from desync.

---

## License

MIT - see [`LICENSE`](LICENSE).
