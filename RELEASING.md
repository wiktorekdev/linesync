# Releasing LineSync

This document is for maintainers only.

---

## Publishing a Release

LineSync uses GitHub Actions to build and publish releases automatically. To trigger a release, push a version tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The CI pipeline will build the extension and attach the `.vsix` file to a new GitHub Release.

---

## Version Naming

Follow [Semantic Versioning](https://semver.org/):

- `v0.x.0` — pre-stable releases while the protocol or API may still change
- `v1.0.0` — first stable release
- Patch releases (`v1.0.1`) for bug fixes; minor releases (`v1.1.0`) for new features

---

## Pre-release Checklist

Before pushing a tag:

- [ ] `CHANGELOG` (if maintained) is up to date
- [ ] Version in `extension/package.json` matches the tag
- [ ] CI is green on `main`
- [ ] Manual smoke test: start a session, join from a second window, verify sync works
