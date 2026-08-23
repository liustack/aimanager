# Security Policy

## Reporting a vulnerability

Please report security issues privately, not in a public issue.

Use [GitHub Security Advisories](https://github.com/liustack/summono/security/advisories/new) to open a private report. That keeps the details between you and the maintainer until a fix is out.

Include what you did, what happened, and your OS and Summono version — the same detail a bug report needs. Reports are acknowledged, fixed, and credited unless you prefer otherwise.

## Supported versions

Fixes land on the latest release. Upgrade to the newest version before reporting.

## What to keep in mind

Summono downloads and installs software: the Node.js runtime from nodejs.org, dsh from the npm registry, and desktop apps from their vendors' official download URLs. It never bundles or substitutes third-party binaries of its own. Anything installed runs under your user account with your permissions, the same as installing it by hand.
