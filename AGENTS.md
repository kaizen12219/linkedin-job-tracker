# Release versions

- Increment the version for every published runtime change. Use a patch increment for fixes, a minor increment for added features, and a major increment for incompatible changes.
- Keep `manifest.json`, `package.json`, and both root version fields in `package-lock.json` identical. Preserve the public manifest key so extension identity and stored settings remain stable.
- A requested rollback selects the baseline release; later updates must increment from that baseline.
- Run `node scripts/check-version.cjs`, the relevant tests, and the package checks before publishing. Record user-visible changes in `CHANGELOG.md`.
