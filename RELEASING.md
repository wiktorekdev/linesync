# Releasing LineSync

Maintainer-only guide.

---

## Publish a Release

LineSync release pipeline is triggered by version tags:

```bash
git tag v0.1.0
git push origin v0.1.0
```

CI builds extension and attaches `.vsix` to GitHub Release.

---

## Versioning

Use [Semantic Versioning](https://semver.org/):

- `v0.x.0` for pre-stable protocol/API iterations
- `v1.0.0` for first stable release
- Patch (`v1.0.1`) for fixes
- Minor (`v1.1.0`) for features

---

## Pre-release Checklist

- [ ] `extension/package.json` version matches tag
- [ ] CI is green on `main`
- [ ] Manual smoke test: host starts session, peer joins with token, sync works
- [ ] Release notes updated (if maintained)
