# dsh-safe-autoupdate

`dsh-safe-autoupdate` is a narrowly scoped Profile Bundle for automatically updating an npm-installed DeepSeek Harness core. It checks the official npm package metadata, waits until the current DSH process exits, installs an exact version into the same npm prefix, verifies the result, and rolls back to the previous exact version if verification fails.

## Safety boundary

- Updates only `@deepseek-ai/dsh` in the detected npm installation prefix.
- Does not update installed profile plugins.
- Does not read or write API keys, credential files, settings, workspaces, sessions, conversations, or attachments.
- Writes state and logs only under `$DSH_HOME/plugins-data/dsh-safe-autoupdate/`.
- Refuses source checkouts and npx-managed cache installations instead of guessing a target.
- Uses exact versions for both update and rollback.
- Does not contain any Git network operation. Repository pushes are a maintainer action; `npm run audit:remote` rejects non-GitHub push remotes.

The updater runs package installation commands with the current user's npm configuration. Review your npm registry and proxy settings before enabling automatic application.

## Install

From a checkout:

```bash
dsh plugin --profile web add /absolute/path/to/dsh-safe-autoupdate
```

From GitHub after the repository has been published:

```bash
dsh plugin --profile web add github:OWNER/dsh-safe-autoupdate
```

Restart DSH and confirm the composed row:

```bash
dsh --profile web --dump-config
```

## Defaults

The bundle checks 30 seconds after startup and every six hours. When it finds a newer `latest` version, it arms a detached helper. The helper changes nothing while DSH is running; it applies the update after that process exits.

To keep automatic checks but require manual package installation, override the row in the profile's user patch and set `autoApply: false`. A user-layer row replaces the full config, so restate every value you need.

## Supported installations

Supported: `npm install --global @deepseek-ai/dsh` and equivalent npm-prefix layouts.

No action is taken for:

- `npx @deepseek-ai/dsh web`, because npx already manages its cache and resolves the package at launch;
- source checkouts, because updating them would require Git operations, dependency installation, and a rebuild;
- an installation whose package root or prefix cannot be proven from the running launcher.

## Verify

```bash
npm run check
npm run pack:check
npm run audit:remote
```

The automated tests cover semantic-version selection, installation-prefix detection, npx refusal, transaction verification, rollback, state-directory isolation, and forbidden runtime access paths.
