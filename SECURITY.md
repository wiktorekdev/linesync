# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in LineSync, **please do not open a public GitHub issue.**

Instead, contact the maintainer directly with:

- A description of the vulnerability
- Steps to reproduce it
- The potential impact, if known

We will acknowledge receipt as quickly as possible and work on a fix. Once a patch is ready and deployed, the issue may be disclosed publicly.

---

## Scope

Areas most relevant to security reports:

- **Session encryption** — AES-GCM key derivation, IV/nonce handling, verifier logic
- **Relay authentication** — session access control, password verifier design
- **Extension trust** — how the extension handles data from the relay or peers

---

## Out of Scope

- Weak passwords chosen by users (the protocol cannot protect against this)
- Relay metadata visibility (IP, timing, sizes) — this is a known and documented limitation
- Issues in third-party dependencies not directly related to LineSync's security model
