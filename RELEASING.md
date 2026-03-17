# Releasing LineSync

This file is for maintainers.

## VSIX release (GitHub Releases)
Push a tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions will build the extension and attach a `.vsix` to the release.

