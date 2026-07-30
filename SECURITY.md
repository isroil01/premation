# Security Policy

## Supported versions

This project is pre-1.0 and moves quickly. Only the latest commit on the default
branch receives security fixes. There are no backports to older tags.

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Report it privately through GitHub:

**[Open a private security advisory →](https://github.com/isroil01/motion-editor/security/advisories/new)**

That channel is private to you and the maintainers, and it lets us prepare a fix
before anything is public. If you cannot use it for any reason, contact a
maintainer directly through their GitHub profile and ask for a private channel —
do not include vulnerability details in a public message.

### What to include

- What the issue is, and what an attacker gains.
- Steps to reproduce, or a proof of concept.
- The commit or version you tested.
- Your OS, and the render backend if relevant.

### What to expect

- **Acknowledgement within 7 days.**
- An assessment, and either a fix or an explanation of why we consider it out of
  scope.
- Credit in the release notes if you want it, or anonymity if you prefer.

This is a small volunteer project — there is no bug bounty, and response times
depend on maintainer availability. We will tell you where things stand rather
than leave you guessing.

## Scope

In scope — this repository:

- The Electron main process, preload bridge, and IPC surface.
- The **plugin sandbox**. Plugins run in a Worker with a permission model and
  signature checks; a sandbox escape, a permission bypass, or a way to load
  plugin code before consent is granted is a real vulnerability and the most
  interesting area to look at.
- Project and asset file parsing — `.motion` bundles, SVG, Lottie, and media
  import. Anything that turns a malicious project file into code execution.
- Renderer CSP bypasses, and any path that exfiltrates local data.
- Credential handling in the desktop app (OS keychain use, token storage).

Out of scope:

- **The hosted backend service.** It is not part of this repository. If you have
  found something in the hosted API, still report it through the private advisory
  channel above and say so — it will be routed.
- Vulnerabilities requiring a physical-access or already-root attacker.
- Third-party dependency advisories with no demonstrated impact here. A
  `npm audit` dump is not a report; show it reaching real code.
- Missing hardening that has no exploit path, absent an argued attack.

## A note on the local edition

The `local` build makes no network requests: the transport layer refuses to send,
and it is tested to be inert. If you find *any* outbound request from a
`VITE_EDITION=local` build, that is a bug worth reporting even if you cannot show
harm — the guarantee is the feature.
