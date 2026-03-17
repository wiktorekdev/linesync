# LineSync

<div align="center">

**Live file sync between VS Code instances — no commits, no branches, no ceremony.**

[![CI](https://img.shields.io/github/actions/workflow/status/wiktorekdev/linesync/ci.yml?branch=main&label=ci&style=for-the-badge&logo=githubactions&logoColor=white)](https://github.com/wiktorekdev/linesync/actions/workflows/ci.yml)
![License](https://img.shields.io/github/license/wiktorekdev/linesync?label=license&style=for-the-badge&color=blue&logo=opensourceinitiative&logoColor=white)
![Stars](https://img.shields.io/github/stars/wiktorekdev/linesync?label=stars&style=for-the-badge&color=success&logo=github&logoColor=white)

[![relay-us](https://img.shields.io/website?label=relay-us&style=for-the-badge&url=https%3A%2F%2Flinesync-us.onrender.com%2Fhealth)](https://linesync-us.onrender.com/health)
[![relay-de](https://img.shields.io/website?label=relay-de&style=for-the-badge&url=https%3A%2F%2Flinesync-de.onrender.com%2Fhealth)](https://linesync-de.onrender.com/health)
[![relay-sg](https://img.shields.io/website?label=relay-sg&style=for-the-badge&url=https%3A%2F%2Flinesync-sg.onrender.com%2Fhealth)](https://linesync-sg.onrender.com/health)

</div>

---

LineSync is a lightweight real-time collaboration layer built on top of git. Designed for pair programming, mentoring, and short focused sessions — where seeing your partner's cursor and edits *right now* matters more than a clean commit history.

No branches. No merge ceremonies. Just open a session and start coding together.

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Relays](#relays)
- [Sessions & Encryption](#sessions--encryption)
- [Security](#security)
- [File Limits & Exclusions](#file-limits--exclusions)
- [License](#license)

---

## Installation

1. Download the latest `.vsix` from [GitHub Releases](https://github.com/wiktorekdev/linesync/releases).
2. Open VS Code → **Extensions** → click the `···` menu → **Install from VSIX...**
3. Select the downloaded file and reload when prompted.

---

## Quick Start

**As the host:**
1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run `LineSync: Start New Session`.
2. Share the **session code** and **password** with your collaborator.
   > Alternatively, copy the **join token** (`SESSIONCODE.PASSWORD`) — your collaborator can paste it as-is and LineSync will fill in both fields automatically.

**As the guest:**
1. Run `LineSync: Join Session` from the Command Palette.
2. Paste the session code or the full join token.
3. Enter the password if it wasn't included in the token.

That's it — you're live.

---

## Configuration

Add any of these to your VS Code `settings.json`:

```json
{
  "linesync.relayUrl": "auto",
  "linesync.relayUrls": [
    "wss://linesync-us.onrender.com",
    "wss://linesync-de.onrender.com",
    "wss://linesync-sg.onrender.com"
  ],
  "linesync.userName": "YourName",
  "linesync.mergePolicy": "prompt",
  "linesync.relaySecret": "",
  "linesync.maxFileSizeKB": 512,
  "linesync.ignorePatterns": []
}
```

| Setting | Description |
|---|---|
| `linesync.relayUrl` | WebSocket URL of the relay to use, or `"auto"` to pick the lowest-latency one automatically. |
| `linesync.relayUrls` | List of relay candidates evaluated when `relayUrl` is `"auto"`. |
| `linesync.userName` | Display name shown to other participants in a session. |
| `linesync.mergePolicy` | What to do when auto-merge fails. Default: `"prompt"`. |
| `linesync.relaySecret` | Optional shared secret for connecting to a private relay. |
| `linesync.maxFileSizeKB` | Files larger than this (in KB) are skipped during sync. |
| `linesync.ignorePatterns` | Additional glob patterns or folder paths to exclude from sync. |

---

## Relays

LineSync ships with three public relays across three regions. When `relayUrl` is `"auto"`, LineSync pings all of them and connects to whichever responds fastest.

| Region | URL |
|---|---|
| US West | `wss://linesync-us.onrender.com` |
| Frankfurt, Germany | `wss://linesync-de.onrender.com` |
| Singapore | `wss://linesync-sg.onrender.com` |

Community-hosted relays are listed in [COMMUNITY_RELAYS.md](COMMUNITY_RELAYS.md). You can also run your own relay for full control over privacy and reliability.

---

## Sessions & Encryption

Every session is identified by a **session code** (e.g. `ABCDEF`) and protected by a **password** you set when starting the session.

- File sync messages are encrypted end-to-end with **AES-GCM** using a key derived from the session password. The relay cannot read file contents.
- The password is never sent to the relay in plaintext — only a derived hash (verifier) is used to authenticate participants.
- The **join token** format is `SESSIONCODE.PASSWORD`. Pasting it into the code prompt auto-fills both fields.

> **Use a strong password.** The relay cannot see your files, but a weak password could be vulnerable to offline brute-force against the public verifier hash.

---

## Security

LineSync uses a relay to connect peers. Even with encryption, the relay is a network intermediary.

**What the relay can see:**
- Your IP address and basic connection metadata
- Message timing and approximate sizes
- Session codes

**What the relay cannot see:**
- File contents (encrypted client-side before transmission)
- Your raw session password

**Out of scope:** Message metadata (timing, sizes) is not obfuscated. If traffic pattern analysis is a concern, run a private relay on infrastructure you control.

For reporting vulnerabilities, see [SECURITY.md](SECURITY.md).

---

## File Limits & Exclusions

- Files exceeding `linesync.maxFileSizeKB` are silently skipped.
- Binary files and common generated artifacts (e.g. `node_modules`, build outputs) are excluded by default.
- Add custom exclusions via `linesync.ignorePatterns` using glob syntax or folder paths.

---

## License

MIT — see [`LICENSE`](LICENSE) for details.
