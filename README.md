# Jenkins Health

An [Omarchy](https://omarchy.org) shell plugin (`h3nr1.d14z.jenkins`) that
watches a Jenkins CI controller and reports its health in the bar:

- **Live polling** of controller status, build nodes, build queue, job ball
  colors, and plugin updates (via the Jenkins REST API over `curl`).
- **Health scoring** (0–100) with levels `ok` / `warn` / `critical`,
  combining node offline/disk/response-time signals, queue backlog, stuck
  items, failing jobs, and pending maintenance.
- **Notification layer** for five categories: controller down/up, node
  changes, job failures, queue backlog, and maintenance (quiet-down,
  restart-required, plugin updates). Each category can be toggled off.
- **Safe actions** from the panel: quiet-down toggle, cancel a queue item,
  and take a node offline / back online.

Credentials never appear in a process argument list: the API token is read
from a file with mode 600 and handed to `curl` through a generated netrc
file (also mode 600).

## Setup

1. Create an API token in Jenkins (*your name → Security → API Token*) and
   store it:

   ```bash
   mkdir -p ~/.config/jenkins-health
   printf '%s' 'your-api-token' > ~/.config/jenkins-health/token
   chmod 600 ~/.config/jenkins-health/token
   ```

2. Add the widget to your bar and point it at your controller — set
   `jenkinsUrl`, `jenkinsUser`, and (optionally) `tokenFile` in the widget
   settings of `~/.config/omarchy/shell.json`.

The bar chip shows the health score; click it for the detail panel,
middle-click to refresh immediately.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `jenkinsUrl` | `""` | Base URL of the controller (include the scheme). |
| `jenkinsUser` | `""` | Jenkins user id that owns the API token. |
| `tokenFile` | `~/.config/jenkins-health/token` | File holding the API token (chmod 600). |
| `refreshIntervalSec` | `30` | Poll interval. |
| `queueBacklogThreshold` | `10` | Queue depth above which a backlog is flagged. |
| `diskWarnGb` / `diskCriticalGb` | `25` / `10` | Node free-disk thresholds (GB). |
| `responseTimeWarnMs` | `1000` | Node response-time threshold. |
| `notifyController`, `notifyNodes`, `notifyFailures`, `notifyQueue`, `notifyMaintenance` | `On` | Per-category notification toggles. |

## IPC

The service exposes five commands to scripts and other plugins:

```bash
qs ipc call jenkins-health refresh   # re-read the token, then poll now
qs ipc call jenkins-health status    # JSON state summary
qs ipc call jenkins-health open      # open the detail panel (all monitors)
qs ipc call jenkins-health close     # close the detail panel
qs ipc call jenkins-health toggle    # toggle the detail panel
```

Handy for an omarchy-menu entry, e.g. an action running
`qs ipc call jenkins-health toggle`.

`status` returns `{"state": "ok", "level": "ok", "score": 96, "version": "2.440.3", "updated": "09:41:02", "message": ""}`.

## Install

For development (symlink; edits hot-reload into the running shell):

```bash
./dev.sh            # links this checkout into ~/.config/omarchy/plugins
omarchy plugin enable h3nr1.d14z.jenkins
```

For a real install from a git remote:

```bash
omarchy plugin add <git-url> --enable
```

Then add the widget to your bar layout in `~/.config/omarchy/shell.json`
(section `right`, `left`, or `center`).

## Remove

```bash
./dev.sh --remove   # unlink the development checkout
omarchy plugin disable h3nr1.d14z.jenkins   # or remove the widget from shell.json
omarchy plugin remove h3nr1.d14z.jenkins --yes   # remove a git install
```

## Development

```bash
node tests/model_properties.mjs   # 600-scenario property sweep over Model.js
bash tests/e2e/run.sh             # 10-phase runtime E2E (~50s)
```

The E2E suite drives the real Service/BarWidget/Panel in standalone
Quickshell instances against a mock Jenkins controller: scenario dumps,
the notification round-trip, live IPC, safe actions (crumb + POST), the
widget registry lifecycle, and screen captures of both the healthy and
degraded rendered surfaces. It never touches your desktop notification
daemon, and screenshots capture only the test window.

## Credits

The Jenkins butler logo (`jenkins.svg`) is the official Jenkins mark,
© 2004 Kohsuke Kawaguchi, licensed CC BY-SA 3.0 — see
https://www.jenkins.io/artwork/.

## License

MIT — see [LICENSE](LICENSE).
