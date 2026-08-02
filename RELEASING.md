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

### Signing — read before your first public release

| Platform | Unsigned consequence |
| --- | --- |
| **Windows** | SmartScreen warns ("unrecognised app"). Installs fine, auto-update works. Fix: OV/EV certificate via `CSC_LINK` + `CSC_KEY_PASSWORD`. |
| **macOS** | Gatekeeper **blocks** the app, and Squirrel.Mac **refuses** updates it cannot verify. Auto-update is therefore off on macOS until signed — `electron/updater.ts` keeps it behind `MOTION_ENABLE_MAC_UPDATES=1`. Fix: Apple Developer ID + notarization. |
| **Linux** | AppImage needs neither. |

macOS users can still install manually (right-click ▸ Open), but they will not get
automatic updates. That is the one gap in this pipeline, and it costs an Apple
Developer account to close.

---

## 5. Checklist

- [ ] `VITE_BACKEND_ORIGIN` set as a repo variable, pointing at the deployed backend
- [ ] `npm run release:patch` (never edit the version by hand)
- [ ] `git push --follow-tags`
- [ ] Workflow green on all three platforms
- [ ] Installed the Windows build on a clean machine and confirmed it reaches the backend
- [ ] Release notes written, then **Publish release**
- [ ] Verified an older install offers the update and applies it
