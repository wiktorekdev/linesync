# Community Relays

LineSync works with any compatible relay server — not just the official ones. This page lists third-party relays contributed by the community.

> **Note:** Community relays are operated by independent third parties. They may log IP addresses and connection metadata. Use them at your own risk. If you need privacy guarantees or higher reliability, [run your own relay](relay/).

---

## Official Relays

These are the relays bundled with LineSync and used for auto-selection by default.

| Region | URL | Notes |
|---|---|---|
| US West | `wss://linesync-us.onrender.com` | Public. Password required. |
| Frankfurt, Germany | `wss://linesync-de.onrender.com` | Public. Password required. |
| Singapore | `wss://linesync-sg.onrender.com` | Public. Password required. |

---

## Community Relays

*No community relays yet — be the first to add one!*

| Region | URL | Operator |
|---|---|---|

---

## Adding Your Relay

Open a pull request that adds a new row to the **Community Relays** table above with:

- **Region** — short label, e.g. `US-East`, `EU-West`, `AU`
- **URL** — must use `wss://`
- **Operator** — your GitHub handle or a contact link

Please keep your relay reachable and remove it via PR if you take it down.

---

## Security Reminder

All relays — official and community — can observe:

- Connection metadata (IP addresses, timing, message sizes)
- Session codes

They **cannot** read file contents when end-to-end encryption is enabled. Encryption strength depends on the session password: always use a strong, randomly generated one.
