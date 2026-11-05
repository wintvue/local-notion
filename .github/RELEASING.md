# CI and releases

## Pull requests and main

CI runs on pull requests, pushes to main and the implementation branch, and manual dispatch. It checks JavaScript syntax and unit tests on Node 24 and 26, then runs the real Electron UI suite and builds unsigned macOS apps on both Apple Silicon and Intel runners. `npm ci` uses the committed lockfile. The stable `CI passed` check succeeds only when all test/build jobs pass; configure this as a required check after merging the initial implementation. Branch protection is not modified automatically.

Unit coverage and logs are uploaded for 14 days. Desktop logs, screenshots, structured test results, and zipped unsigned apps are retained for 7 days. The UI driver uses a temporary SQLite workspace, treats renderer errors as failures, captures failure screenshots, and has a two-minute watchdog. Workflow jobs also have explicit time limits. No real workspace data or credentials are included in artifacts.

The workflow token is read-only except for the final release publication job. Actions are pinned to verified full commit hashes, checkout credentials are not persisted, and Dependabot checks npm and Actions weekly. Pull-request jobs have no release secrets. Concurrency cancels stale CI runs but never cancels an in-progress release.

## Local verification

```sh
npm ci
npm run verify        # syntax and unit tests with coverage
npm run e2e           # real Electron tests; graphical macOS session required
npm run dist -- --config.electronDist=node_modules/electron/dist --publish never
node scripts/verify-package.js
```

The unit report covers the storage, seed, and release helper code exercised by Node; renderer behavior is covered separately by Electron UI checks. It is not a claim of total application coverage.

## Signed releases

Releases are triggered only by a pushed version tag. The workflow validates that the tag exactly matches `v` plus the package version and that its commit has already been merged into main. It reruns the complete CI suite before building signed, notarized DMG and ZIP installers for both Mac architectures. Every architecture must pass before the publication job can run.

Create a GitHub environment named `release` and configure these environment secrets:

| Secret | Value |
| --- | --- |
| `CSC_LINK` | Base64-encoded Developer ID Application signing certificate (.p12) |
| `CSC_KEY_PASSWORD` | Certificate password |
| `MAC_SIGNING_IDENTITY` | Developer ID Application identity matching the certificate |
| `APPLE_ID` | Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for notarization |
| `APPLE_TEAM_ID` | Apple Developer team identifier |

Use environment protection rules and restrict tag creation to trusted maintainers as appropriate for the account's GitHub plan. Missing credentials fail the build; releases never silently fall back to unsigned output. CI artifacts remain unsigned and are for internal testing.

After merging the implementation, update package.json and package-lock.json together in a reviewed PR. Once merged:

```sh
git switch main
git pull --ff-only
# Replace with the exact package.json version.
git tag -a v1.0.0 -m 'Release 1.0.0'
git push origin v1.0.0
```

The release workflow verifies the app archive contents, signature, notarization ticket, and Gatekeeper assessment, then generates SHA-256 checksums and creates a **draft** GitHub release. Review and manually publish the draft. No release tag is created or published by CI on a normal merge. Existing releases are not overwritten on rerun; if publication failed after draft creation, inspect the draft before retrying.

The current app uses Notion's trademarked icon for personal use. Keep this repository and its builds private. Replace the icon and branding with assets you may distribute before publishing externally, as explained in the main README. Signing credentials and branding changes are prerequisites for external distribution, not completed by this workflow setup.

References: [GitHub Actions security](https://docs.github.com/en/actions/reference/security/secure-use), [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), [electron-builder macOS configuration](https://www.electron.build/mac/).
