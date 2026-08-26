# dsh-safe-autoupdate

`dsh-safe-autoupdate` is a narrowly scoped Profile Bundle for automatically updating npm-installed and official-source DeepSeek Harness deployments. It waits for active agents to become idle, gracefully restarts DSH, applies an exact package version or source commit, verifies the result, and rolls back if verification fails.

## Safety boundary

- Updates only `@deepseek-ai/dsh` in the detected npm installation prefix.
- For source mode, accepts only a clean checkout whose `origin` is exactly `deepseek-ai/deepseek-harness` on GitHub and whose update is fast-forward-only.
- Source updates use `pnpm install --frozen-lockfile`, build, and `pnpm dsh --version` verification; failure restores the original commit, dependencies, and build.
- Does not update installed profile plugins.
- Does not read or write API keys, credential files, settings, workspaces, sessions, conversations, or attachments.
- Writes state and logs only under `$DSH_HOME/plugins-data/dsh-safe-autoupdate/`.
- Refuses unsupported source checkouts and npx-managed cache installations instead of guessing a target.
- Uses exact package versions or Git commits for both update and rollback.
- Restarts only after the observed agent set is idle and a two-minute grace period has elapsed.
- Sends `SIGTERM` and aborts the update if DSH does not shut down within the configured timeout; it never force-kills the process.
- Refuses automatic restart when launcher arguments look like they may contain credentials.
- Source mode fetches only from the validated official GitHub remote and never pushes. Repository pushes are a maintainer action; `npm run audit:remote` rejects non-GitHub push remotes.

The updater runs package installation commands with the current user's npm configuration. Review your npm registry and proxy settings before enabling automatic application.

## Install

From a checkout:

```bash
dsh plugin --profile web add /absolute/path/to/dsh-safe-autoupdate
```

From GitHub after the repository has been published:

```bash
dsh plugin --profile web add github:Musenn/dsh-safe-autoupdate
```

Restart DSH and confirm the composed row:

```bash
dsh --profile web --dump-config
```

## Defaults

The bundle checks 30 seconds after startup and every six hours. When it finds a newer `latest` version, it waits until all observed agents are idle, allows a two-minute grace period, then asks DSH to shut down with `SIGTERM`. The detached helper applies the update, verifies it, and starts the same DSH surface again. A new agent becoming busy during the grace period cancels and defers the restart.

Automatic checks, application, and restart are enabled by default. Set `autoRestart: false` to update only on the next natural process exit, or set `autoApply: false` to check and report without changing the installation.

To keep automatic checks but require manual package installation, override the row in the profile's user patch and set `autoApply: false`. A user-layer row replaces the full config, so restate every value you need.

## Supported installations

Supported:

- `npm install --global @deepseek-ai/dsh` and equivalent npm-prefix layouts;
- a clean official source checkout launched with `pnpm dsh ...`, tracking a branch from `https://github.com/deepseek-ai/deepseek-harness.git`.

No action is taken for:

- `npx @deepseek-ai/dsh web`, because npx already manages its cache and resolves the package at launch;
- dirty, detached, non-fast-forward, forked, mirrored, or non-GitHub source checkouts;
- an installation whose package root or prefix cannot be proven from the running launcher.

## Verify

```bash
npm run check
npm run pack:check
npm run audit:remote
```

The automated tests cover semantic-version selection, npm and source-installation detection, npx refusal, exact package and source transactions, graceful restart, rollback, state-directory isolation, official-remote enforcement, and forbidden runtime access paths.
