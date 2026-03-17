# Security Policy

## Reporting a Vulnerability

If you discover a security issue in LineSync, do not open a public GitHub issue.

Contact the maintainer directly and include:

- Description of the issue
- Reproduction steps
- Potential impact

We will acknowledge receipt quickly, work on a patch, and coordinate disclosure timing.

---

## Scope

Most relevant areas:

- Session encryption (AES-GCM key derivation, IV/nonce handling, verifier logic)
- Relay authentication and access control
- Extension trust boundary with relay/peer data

---

## Out of Scope

- Leaked session tokens shared by users
- Relay metadata visibility (IP/timing/size), which is a documented limitation
- Vulnerabilities in third-party dependencies not specific to LineSync logic
