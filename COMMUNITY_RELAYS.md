# Community relays

This project can work with any compatible LineSync relay.
Relays are run by third parties and may log IP addresses and metadata.
Use at your own risk. If you need privacy or reliability, run your own relay.

## Official relays

| Region | URL | Notes |
|---|---|---|
| US | `wss://linesync-us.onrender.com` | Public relay. Password required. |
| DE | `wss://linesync-de.onrender.com` | Public relay. Password required. |
| SG | `wss://linesync-sg.onrender.com` | Public relay. Password required. |

## Add your relay

Open a PR that adds a new row under a "Community relays" section with:

- Relay URL (must be `wss://`)
- Region (short, e.g. "US-East")
- Operator / contact (GitHub handle)

## Disclaimer

- Relays can observe traffic size/timing and connection metadata.
- End-to-end encryption depends on users choosing a strong session password.
- Do not use public relays for secrets unless you understand the risks.

