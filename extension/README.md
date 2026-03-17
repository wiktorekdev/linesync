<div align="center">
  <h1>LineSync</h1>
  <p><strong>Real-time file sync between VS Code instances.<br/>No commits. No branches. No ceremony.</strong></p>

  [![CI](https://img.shields.io/github/actions/workflow/status/wiktorekdev/linesync/ci.yml?branch=main&label=ci&style=flat-square&logo=githubactions&logoColor=white)](https://github.com/wiktorekdev/linesync/actions)
  ![License](https://img.shields.io/github/license/wiktorekdev/linesync?style=flat-square&color=blue)
  [![relay-us](https://img.shields.io/website?label=relay-us&style=flat-square&url=https%3A%2F%2Flinesync-us.onrender.com%2Fhealth)](https://linesync-us.onrender.com/health)
  [![relay-de](https://img.shields.io/website?label=relay-de&style=flat-square&url=https%3A%2F%2Flinesync-de.onrender.com%2Fhealth)](https://linesync-de.onrender.com/health)
  [![relay-sg](https://img.shields.io/website?label=relay-sg&style=flat-square&url=https%3A%2F%2Flinesync-sg.onrender.com%2Fhealth)](https://linesync-sg.onrender.com/health)
</div>

---

LineSync is a lightweight collaboration tool for developers who need to share code *right now* - without touching git. Start a session in seconds and let your teammates see every keystroke as it happens.

Built for **pair programming**, **code reviews**, and **mentoring** where live context beats async patches.

---

## How it works

---

## Features

- **Live sync** - edits appear on the guest's machine as you type
- **End-to-end encrypted** - file contents are encrypted with AES-GCM; the relay never sees your code
- **Auto-relay selection** - connects to the lowest-latency public relay automatically
- **One-paste joining** - share a single session token and guests are in with no extra steps
- **Token-protected sessions** - only people with the token can join
- **Smart file exclusions** - skips binaries, generated files, and anything you configure

---

## Getting Started

### 1 - Start a session (host)

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run:

```
LineSync: Start New Session
```

LineSync auto-generates a secret and copies a **session token** to your clipboard. Share that token for a single-paste join.

### 2 - Join a session (guest)

Open the Command Palette and run:

```
LineSync: Join Session
```

Paste the session token. You're live.

---

## Configuration

```json
{
  "linesync.relayUrl": "auto",
  "linesync.userName": "YourName",
  "linesync.maxFileSizeKB": 512,
  "linesync.ignorePatterns": []
}
```

| Setting | Default | Description |
|---|---|---|
| `linesync.relayUrl` | `"auto"` | Relay URL, or `"auto"` to pick the fastest one. |
| `linesync.relayUrls` | *(built-in list)* | Override the relay candidates used during auto-selection. |
| `linesync.userName` | `""` | Your display name shown to other session participants. Empty = anonymous generated name. |
| `linesync.relaySecret` | `""` | Shared secret for connecting to a private relay. |
| `linesync.maxFileSizeKB` | `512` | Skip files larger than this size. |
| `linesync.ignorePatterns` | `[]` | Extra glob patterns or folders to exclude from sync. |

---

## Public Relays

LineSync ships with three public relays. The extension pings all of them on startup and connects to whichever is fastest.

| Region | URL |
|---|---|
| US West | `wss://linesync-us.onrender.com` |
| Frankfurt | `wss://linesync-de.onrender.com` |
| Singapore | `wss://linesync-sg.onrender.com` |

Need more control? You can self-host the relay - see the [GitHub repository](https://github.com/wiktorekdev/linesync) for instructions.

---

## Security

LineSync encrypts all file data **before** it leaves your machine using **AES-GCM** with a key derived from your session secret.

The relay routes messages between peers but cannot read your files. It can see:
- IP addresses and connection metadata
- Message sizes and timing
- Session identifiers (not file contents)

For this reason, keep your **session token private**.

For vulnerability reports, see [SECURITY.md](https://github.com/wiktorekdev/linesync/blob/main/SECURITY.md).

---

## Requirements

- VS Code `1.80.0` or later

---

## Links

- [GitHub Repository](https://github.com/wiktorekdev/linesync)
- [Report an Issue](https://github.com/wiktorekdev/linesync/issues)
- [Contributing Guide](https://github.com/wiktorekdev/linesync/blob/main/CONTRIBUTING.md)
- [Community Relays](https://github.com/wiktorekdev/linesync/blob/main/COMMUNITY_RELAYS.md)

---

## License

MIT - see [LICENSE](https://github.com/wiktorekdev/linesync/blob/main/LICENSE) for details.
