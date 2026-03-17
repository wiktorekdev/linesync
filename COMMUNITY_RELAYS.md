# Community Relays

LineSync works with any compatible relay server, not only the official cluster.

> Community relays are operated by third parties. They may log connection metadata. If you need strict privacy and reliability guarantees, run your own relay.

---

## Official Relays

These endpoints are bundled by default.

| Region | URL |
|---|---|
| US West | `wss://linesync-us.onrender.com` |
| Frankfurt, Germany | `wss://linesync-de.onrender.com` |
| Singapore | `wss://linesync-sg.onrender.com` |

---

## Community Relays

*No community relays listed yet.*

| Region | URL | Publisher |
|---|---|---|

---

## Adding Your Relay

Open a pull request and add a row with:

- **Region**: short label, for example `US-East`, `EU-West`, `AU`
- **URL**: must use `wss://`
- **Publisher**: organization, team name, or GitHub handle/contact link

Keep your endpoint reachable and remove it from the list if you shut it down.

---

## Security Reminder

Relays can observe:

- Connection metadata (IP addresses, timings, message sizes)
- Session identifiers

Relays cannot read encrypted file payloads.
