# agent-browser Lockfile

Pre-generated lockfile for build scripts. Avoids slow dependency resolution
(webdriverio has 200+ transitive deps) and postinstall GitHub download hang.

## Upgrade Steps

When bumping `AGENT_BROWSER_VERSION` in `src/server/index.ts`:

```bash
cd src/server/agent-browser-lockfile
# Update version in package.json
bun install --ignore-scripts
# Commit both package.json and bun.lock
```
