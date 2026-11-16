---
"pi-freeflow": minor
---

Install and update from GitHub release assets instead of the npm registry. `/freeflow update` and the background update check now read the newest GitHub release tag, download that release's tarball, and install it with npm or bun — so neither installation nor updates need an npm account, a registry session, or a working publish path. npm 12 refuses remote and git specifiers by default, which is why the tarball is downloaded and installed as a local file. Each release publishes the verified tarball as an asset, including a stable `pi-freeflow.tgz` name for the latest-release download link.
