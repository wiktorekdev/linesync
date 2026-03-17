<div align="center">
  <h1>LineSync</h1>
  <p><strong>Premium live collaboration for VS Code.<br/>Instant peer sync without branches or commits.</strong></p>

  [![CI](https://img.shields.io/github/actions/workflow/status/wiktorekdev/linesync/ci.yml?branch=main&label=ci&style=flat-square&logo=githubactions&logoColor=white)](https://github.com/wiktorekdev/linesync/actions)
  ![License](https://img.shields.io/github/license/wiktorekdev/linesync?style=flat-square&color=blue)
  [![relay-us](https://img.shields.io/website?label=relay-us&style=flat-square&url=https%3A%2F%2Flinesync-us.onrender.com%2Fhealth)](https://linesync-us.onrender.com/health)
  [![relay-de](https://img.shields.io/website?label=relay-de&style=flat-square&url=https%3A%2F%2Flinesync-de.onrender.com%2Fhealth)](https://linesync-de.onrender.com/health)
  [![relay-sg](https://img.shields.io/website?label=relay-sg&style=flat-square&url=https%3A%2F%2Flinesync-sg.onrender.com%2Fhealth)](https://linesync-sg.onrender.com/health)
</div>

---

## Features

- Live sync of code changes as peers type
- End-to-end encrypted payloads (AES-GCM)
- Relay auto-selection v2 (multi-sample latency + health memory)
- One-token join flow
- Drift detection, conflict hints, safe auto-resync
- Smart file exclusions and snapshot fallback for larger files

---

## Getting Started

### Host

Run from Command Palette:

```
LineSync: Start Session
```

LineSync generates and copies a **session token**.

### Peer

Run:

```
LineSync: Join Session
```

Paste the session token.

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

---

## Official Relays

| Region | URL |
|---|---|
| US West | `wss://linesync-us.onrender.com` |
| Frankfurt | `wss://linesync-de.onrender.com` |
| Singapore | `wss://linesync-sg.onrender.com` |

---

## Security

LineSync encrypts file payloads before sending them to relay.

Relay can observe metadata (IP, timing, message sizes, session identifiers), but cannot read encrypted file contents.

For vulnerability reporting, see [SECURITY.md](https://github.com/wiktorekdev/linesync/blob/main/SECURITY.md).

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

MIT - see [LICENSE](https://github.com/wiktorekdev/linesync/blob/main/LICENSE).
