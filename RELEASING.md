# Releasing Premation

How a version becomes installers, how those installers reach users through GitHub
Releases, and how an already-installed app finds the next version.

---

## 1. Where a build comes out

Everything lands in **`release/`** (gitignored). A Windows build produces:

```
motion-editor/release/
├── Premation-Setup-Windows.exe           ← the installer users download (~90 MB)
├── Premation-Setup-Windows.exe.blockmap
├── latest.yml                            ← update manifest: version + sha512 + filename
├── builder-debug.yml
└── win-unpacked/                          ← the unpacked app (for local testing)
    └── resources/
        ├── app.asar                       ← your code + production node_modules
        └── app-update.yml                 ← where this app looks for updates
```

Per platform:

| Platform | Command | Artifact |
| --- | --- | --- |
| Windows | `npm run dist` (on Windows) | `Premation-Setup-Windows.exe` + `latest.yml` |
| macOS | `npm run dist` (on macOS) | `Premation-macOS-arm64.dmg`, `Premation-macOS-x64.dmg` + `latest-mac.yml` |
| Linux | `npm run dist` (on Linux) | `Premation.AppImage` + `latest-linux.yml` |

Each platform must be built **on** that platform. That is what the release
workflow's three-runner matrix is for.

`npm run pack` is the fast variant: it produces `win-unpacked/` only, with no
installer — useful when you just want to run the packaged app.

`.blockmap` and `latest.yml` are not incidental. The blockmap lets an update
download only the changed chunks of the installer instead of all 90 MB; `latest.yml`
is the file every installed copy fetches to learn whether a newer version exists.
Publish them alongside the installer or auto-update cannot work.

> **How updates reach users.** The app checks on a timer (not just at launch),
> downloads in the background without asking, and installs on quit. The only
> thing a user sees is a dismissible "update ready — Restart now" toast. A
> `Download updates automatically` toggle in Customize ▸ Appearance turns the
> background download off for anyone on a metered connection; an update they
> fetch by hand still installs on quit. See `electron/updater.ts`.
>
> Because installs happen on quit and a draft release is invisible until you
> press Publish, "Publish" in the GitHub UI is the moment every installed app
> starts rolling forward. Treat it as the deploy step it is.

### Two local-build gotchas on this machine

Both are environmental, and neither affects CI:

1. **`npm run dist` fails while the app is running.** electron-builder rebuilds
   native modules and Windows will not let it replace `better_sqlite3.node` while
   an Electron process holds it (`EBUSY`/`EPERM`). Close the running app first.
2. **electron-builder's `winCodeSign` download needs symlink privileges.**
   Extracting it fails with *"Cannot create symbolic link: A required privilege
   is not held"* unless Windows Developer Mode is on or the shell is elevated.
   Enable Developer Mode, or pass `-c.win.signAndEditExecutable=false` for a
   local test build (which skips the installer's icon/version metadata — never
   ship that build).

---

## 2. Versioning

`package.json` `version` is the single source of truth. electron-builder reads it,
writes it into `latest.yml`, and the updater compares against it. The git tag is
only the trigger.

```bash
npm run release:patch      # 0.1.0 → 0.1.1, commits, tags v0.1.1
npm run release:minor      # 0.1.0 → 0.2.0
npm run release:major      # 0.1.0 → 1.0.0
git push --follow-tags     # this is what starts the release workflow
```

`npm version` makes the commit and the tag together, which is what keeps them
from drifting. If you tag by hand and the numbers disagree, the `verify` job
fails the build rather than shipping a release whose metadata contradicts its
name — that mismatch is what makes clients either never see an update or install
one repeatedly.

---

## 3. Distribution through GitHub Releases

Pushing a `v*` tag runs `.github/workflows/release.yml`:

1. **verify** — tag matches `package.json`, typecheck (renderer + electron), full test suite.
2. **build** — three runners in parallel: Windows, macOS (both architectures in one
   job), Linux. Each runs `electron-builder --publish always`.
3. Assets upload to a **draft** release.

The result is exactly the layout you want:

```
GitHub Repository
├── Source code
└── Releases
    └── v0.1.1  (draft until you publish it)
        ├── Premation-Setup-Windows.exe
        ├── Premation-macOS-arm64.dmg
        ├── Premation-macOS-x64.dmg
        ├── Premation.AppImage
        ├── latest.yml / latest-mac.yml / latest-linux.yml
        └── *.blockmap
```

Write the release notes, then press **Publish release**. Nothing reaches users
before that — a draft is invisible to the updater. That is the review gate
between "the build finished" and "everyone gets it".

### One-time repository setup

**Settings ▸ Secrets and variables ▸ Actions ▸ Variables:**

| Variable | Value |
| --- | --- |
| `VITE_BACKEND_ORIGIN` | `https://api.your-domain.com` — the deployed motion-back |
| `VITE_MEDIA_ORIGINS` | optional; defaults to Cloudinary |

`GITHUB_TOKEN` is provided automatically; no personal token is needed.

Without `VITE_BACKEND_ORIGIN` the workflow still succeeds but logs a warning, and
the installers point at `http://localhost:4000` — correct for a self-hosted
install, useless for everyone else. See `motion-back/DEPLOYMENT.md`.

macOS builds both architectures in a **single** job on purpose: two jobs would
each publish their own `latest-mac.yml` and the second would overwrite the first,
leaving one architecture unable to update.

---

## 4. How an installed app gets the update

`electron/updater.ts`, on top of `electron-updater`:

1. On launch (after the window is visible), the app fetches `latest.yml` from the
   latest **published** release.
2. Newer version → a dialog: **Download** or **Later**. Nothing downloads without
   consent — a silent 90 MB pull on a tethered connection is not a courtesy.
3. Download finishes → **Restart now** or **On next launch**. "Later" still
   installs on quit rather than discarding the download.
4. Failures are logged, never shown — except when the user asked via
   **Help ▸ Check for Updates…**, where silence would be the bug.

So a user on 0.1.0 launches the app, is offered 0.1.1, and is running it a minute
later. No re-download from the website, no manual uninstall.

Escape hatches: `MOTION_DISABLE_UPDATES=1` turns it off. Dev builds never check.

### Platform support — Windows and macOS only

Linux is **deliberately unsupported**, not overlooked. The AppImage target was
removed from `electron-builder.yml` and the release matrix rather than commented
out, so nobody re-enables a target nobody tests. Re-adding it costs: a third
build runner, a third update channel (`latest-linux.yml`) to keep in sync, and a
platform none of us runs day to day — which is how a target rots into shipping
broken builds that look fine in CI.

macOS ships **both architectures** (`arm64` and `x64`) from one job, sharing a
single `latest-mac.yml`. Shipping x64-only and letting Apple Silicon users find
out is not an option: Rosetta runs it, badly, and the user has no way to know
that is why it feels slow.

---

## 5. Unsigned macOS distribution — ACCOMMODATION, dated

**Started:** 2026-08-03
**Expires:** when the Apple Developer Program membership and Developer ID
certificate land.
**How it ends:** populate the five macOS secrets. The workflow switches paths on
its own — there is no code to revert, and nothing to remember.

macOS ships **unsigned and un-notarized**, publicly, not as a beta. Gatekeeper
will block it on first launch and the user must allow it via **System Settings ▸
Privacy & Security**. This is a decision, not an oversight, and the release notes
must say so — the workflow prints the exact wording into its job summary so
whoever publishes the draft can paste it.

This is the **fifth** instance of a pattern this project keeps catching: a
temporary accommodation with no expiry condition. The previous four were
`CSC_IDENTITY_AUTO_DISCOVERY: false` hardcoded to make CI pass, six dead OneDrive
paths in `launch.json`, the stale right-click install advice below, and the
landing site's Linux row. Each was reasonable when made and wrong six months
later, because nothing said when it should stop.

**So this one has an expiry written into it, and the mechanism enforces it
rather than a person remembering.** If you find yourself extending this section
rather than deleting it, that is the pattern winning again.

What the pipeline does NOT do is treat "we chose not to sign" and "signing broke"
as the same thing. Skipping is allowed and announced; *failing* still fails the
release. That distinction is the whole design — an unsigned artifact is
acceptable while we have no certificate, but an unsigned artifact nobody noticed
is not.

---

## 6. Code signing

**The macOS "not allowed" error users report is Gatekeeper blocking an unsigned,
unnotarized app. It is not a bug in the build — it is a missing signing
pipeline.**

The workflow now refuses to publish an unsigned artifact. `electron-builder` does
NOT fail when `CSC_LINK` is empty — it silently skips signing and carries on — so
the verification steps after packaging are what actually hold the line.

### What you need to obtain

| Secret | What it is | Where from |
| --- | --- | --- |
| `MAC_CSC_LINK` | base64 of the **Developer ID Application** `.p12` | Apple Developer Program ($99/yr) → Certificates |
| `MAC_CSC_KEY_PASSWORD` | password for that `.p12` | set when exporting from Keychain |
| `APPLE_ID` | the Apple ID that owns the membership | — |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password, **not** the account password | appleid.apple.com → Sign-In and Security |
| `APPLE_TEAM_ID` | 10-character team identifier | Apple Developer → Membership |
| `WIN_CSC_LINK` | base64 of the Windows code-signing cert | see Windows below |
| `WIN_CSC_KEY_PASSWORD` | its password | — |

All are **CI secrets**. Never in the repo, never in build config.

If we ship a `.pkg` later, that additionally needs a **Developer ID Installer**
certificate — the Application one cannot sign an installer package.

### macOS — required, do this first

1. Apple Developer Program membership → **Developer ID Application** certificate.
2. Sign with **hardened runtime** (mandatory for notarization) and a secure
   timestamp. Every embedded binary, framework and helper must be signed —
   missed components are the most common notarization rejection, which is why
   `electron-builder.yml` leaves deep signing on rather than narrowing it for
   build speed. Entitlements are in `build/entitlements.mac.plist`; each one is
   there because the hardened runtime otherwise breaks V8 or Electron's own
   frameworks.
3. Submit with `xcrun notarytool submit --wait`.
4. **Staple** the ticket with `xcrun stapler staple`. Skipping this is the subtle
   failure: a machine that is offline, or behind a filter that blocks Apple's
   verification endpoints, cannot check notarization and Gatekeeper blocks a
   build that *is* notarized.
5. Verify with `spctl -a -vvv` (`--type install` for a `.pkg`) **on a clean
   machine, after downloading through a browser**. Testing a locally-built
   artifact skips the quarantine attribute and proves nothing.

> **macOS Sequoia removed the Control-click ▸ Open override for unsigned
> software.** Users must now go to **System Settings ▸ Privacy & Security** and
> allow it there. Any instruction telling users to right-click or Control-click
> to open is wrong on current macOS, and worse than saying nothing — it sends
> them somewhere the option no longer exists. Do not reintroduce it.

### Windows — after macOS

SmartScreen shows "Windows protected your PC" on an unsigned executable. Less
severe than macOS — there is still a **More info ▸ Run anyway** path — but it
costs installs.

Before planning, **check eligibility for Azure Trusted Signing** (~$9.99/month,
no hardware token). It is limited to verified businesses and self-employed
individuals in the US, Canada, EU and UK. If we do not qualify, the path is a
traditional **OV certificate** from a CA (~$200–400/yr, hardware token or HSM).

**Do not buy EV for SmartScreen reasons.** The instant-bypass behaviour was
removed in 2024; EV now builds reputation exactly like OV. Reputation starts at
zero either way and accrues from real download telemetry, so **signing will not
remove the warning on day one** — plan for a warning window on the first
release regardless of certificate type.

Always timestamp (RFC 3161) so signatures stay valid after the certificate
expires. The workflow asserts the timestamp is present, because a signature
without one retroactively invalidates every build the day the cert lapses.

### What unsigned costs today

| Platform | Consequence |
| --- | --- |
| **macOS** | Gatekeeper **blocks** the app. Squirrel.Mac also refuses updates it cannot verify, so `electron/updater.ts` checks the bundle's signature with `codesign` at launch and leaves auto-update OFF when it is unsigned — otherwise the app would download every release and then refuse it, once per launch, forever. A signed and notarized build updates itself normally. |
| **Windows** | SmartScreen warns. Installs via "Run anyway"; auto-update works. |

---

## 7. Release policy — enforced, not just documented

1. **Releases are cut from `main` only.** No release, tag or published artifact
   from `dev` or a feature branch.
2. **Flow:** feature branch → `dev` → `main` → tag → release.
3. **Artifacts are built from the tagged commit**, never from a working tree.
4. **A release tag that is not an ancestor of `main` fails the pipeline.**

Gate 1 in `.github/workflows/release.yml` enforces (1) and (4) with
`git merge-base --is-ancestor`. This matters because a tag pushed from `dev`
builds and publishes exactly as convincingly as a real release — same installer,
same update manifest, same users — and nothing downstream can tell the
difference. CI is the only place that can refuse.

## 8. Checklist

- [ ] `VITE_BACKEND_ORIGIN` set as a repo variable, pointing at the deployed backend
- [ ] `npm run release:patch` (never edit the version by hand)
- [ ] `git push --follow-tags`
- [ ] Tag is on `main` (the workflow refuses otherwise)
- [ ] Workflow green on both platforms
- [ ] macOS artifact verified with `spctl` and `stapler validate` on a clean machine, downloaded via a browser
- [ ] Installed the Windows build on a clean machine and confirmed it reaches the backend
- [ ] Release notes written, then **Publish release**
- [ ] Verified an older install offers the update and applies it
