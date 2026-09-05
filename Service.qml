import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// Jenkins Health service (h3nr1.d14z.jenkins), kind "service", keepLoaded.
//
// Polls the Jenkins REST API on a timer, assesses health via Model.js,
// emits edge-triggered notifications for the five categories (controller,
// nodes, failures, queue, maintenance), and runs safe actions on request
// (quiet-down toggle, cancel queue item, node online/offline).
//
// Configuration is pushed here by the BarWidget from its shell.json
// settings (see applyConfig). Until a jenkinsUrl is set the service idles.
//
// Auth: the API token is read from a chmod-600 file and handed to curl via
// a generated netrc file (also chmod 600) — the token never appears in a
// process argument list, so `ps` cannot leak it.

Item {
  id: root

  // Injected by the shell service host.
  property var shell: null
  property string omarchyPath: ""

  // Widget settings, pushed via applyConfig().
  property var config: ({})

  // ---- state surface for widgets
  readonly property string state: internal.stateName
  readonly property var snapshot: internal.snapshot
  readonly property var queueItems: internal.queueItems
  readonly property int score: internal.snapshot ? internal.snapshot.overall.score : 0
  readonly property string level: internal.snapshot ? internal.snapshot.overall.level : ""
  readonly property string controllerStatus: internal.snapshot && internal.snapshot.controller
    ? internal.snapshot.controller.status : ""
  readonly property string version: internal.snapshot && internal.snapshot.controller
    ? (internal.snapshot.controller.version || "") : ""
  readonly property string lastUpdated: internal.lastUpdatedText
  readonly property string statusMessage: internal.statusMessage
  readonly property string actionMessage: internal.actionMessage
  readonly property bool busy: internal.busy

  function applyConfig(cfg) {
    if (!cfg || typeof cfg !== "object") return
    var next = JSON.parse(JSON.stringify(cfg))
    if (JSON.stringify(next) === JSON.stringify(root.config)) return
    root.config = next
    internal.onConfigChanged()
  }

  // Refresh re-reads the token file before polling, so token rotation
  // applies without restarting the shell.
  function refresh() {
    internal.reauth()
  }

  // ---- live widget registry: the service owns the single IPC target and
  // relays panel commands to every monitor's BarWidget instance. Registering
  // here (instead of per-widget IpcHandlers) sidesteps duplicate-target
  // semantics entirely.
  property var widgets: ([])

  function registerWidget(w) {
    if (!w || widgets.indexOf(w) !== -1) return
    widgets = widgets.concat([w])
  }

  function unregisterWidget(w) {
    var i = widgets.indexOf(w)
    if (i === -1) return
    var next = widgets.slice()
    next.splice(i, 1)
    widgets = next
  }

  function relayToWidgets(method) {
    for (var i = 0; i < widgets.length; i++) {
      var w = widgets[i]
      if (w && typeof w[method] === "function") w[method]()
    }
  }

  // action: string ("quietDown" | "cancelQuietDown" | "cancelQueueItem" |
  //                 "nodeOffline" | "nodeOnline") or descriptor object.
  function runAction(action, targetId) {
    internal.runAction(action, targetId)
  }

  QtObject {
    id: internal

    property string stateName: "unconfigured"
    property var snapshot: null
    property var prevSnapshot: null
    property var queueItems: []
    property string lastUpdatedText: ""
    property string statusMessage: ""
    property string actionMessage: ""
    property bool busy: false
    property bool netrcOk: false
    property var fetched: ({})
    property int stepIndex: -1
    property var pendingAction: null
    property string netrcPath: ""
    property string jenkinsUrl: ""
    property string user: ""
    property string tokenFile: ""
    property int generation: 0
    property int pollGeneration: -1

    readonly property var steps: [
      { endpoint: "/api/json", key: "api" },
      { endpoint: "/computer/api/json", key: "computer" },
      { endpoint: "/queue/api/json", key: "queue" },
      { endpoint: "/pluginManager/api/json", key: "plugins" },
      { endpoint: "/updateCenter/api/json", key: "uc" }
    ]

    function expandTilde(path) {
      var home = Quickshell.env("HOME") || ""
      return String(path || "").replace(/^~\/?/, home ? home + "/" : "/")
    }

    function onConfigChanged() {
      generation += 1
      pollTimer.stop()
      netrcOk = false
      snapshot = null
      prevSnapshot = null
      queueItems = []
      busy = false
      stepIndex = -1
      statusMessage = ""
      actionMessage = ""

      jenkinsUrl = String(root.config.jenkinsUrl || "").trim()
      user = String(root.config.jenkinsUser || "").trim()
      tokenFile = String(root.config.tokenFile || "~/.config/jenkins-health/token")

      if (!jenkinsUrl || !user) {
        stateName = "unconfigured"
        statusMessage = !jenkinsUrl
          ? "set jenkinsUrl in the widget settings"
          : "set jenkinsUser in the widget settings"
        return
      }

      var expanded = expandTilde(tokenFile)
      var slash = expanded.lastIndexOf("/")
      netrcPath = slash > 0
        ? expanded.substring(0, slash) + "/netrc"
        : (Quickshell.env("HOME") || "/tmp") + "/.config/jenkins-health/netrc"

      stateName = "starting"
      statusMessage = "reading API token…"
      reauth()
    }

    // Re-read the token file and rewrite the netrc (onNetrcExit chains into
    // a poll on success). Also the entry point for refresh(): token rotation
    // applies without restarting the shell.
    function reauth() {
      if (!jenkinsUrl || !user || netrcProcess.running) return
      netrcProcess.command = netrcCommand()
      netrcProcess.running = true
    }

    function netrcCommand() {
      // Everything reaches the script as a positional argument: no quoting
      // hazards, and the token itself is only ever touched inside bash.
      var script = [
        'umask 077',
        'set -e',
        'out="$1"; tf="${2/#\\~/$HOME}"; user="$3"; url="$4"',
        'h="${url#*://}"; h="${h%%/*}"; h="${h%%:*}"',
        'tok="$(cat "$tf" 2>/dev/null || true)"',
        'if [ -z "$h" ] || [ -z "$user" ] || [ -z "$tok" ]; then echo notoken; exit 0; fi',
        'mkdir -p "${out%/*}" 2>/dev/null || true',
        "printf 'machine %s\\nlogin %s\\npassword %s\\n' \"$h\" \"$user\" \"$tok\" > \"$out\"",
        'chmod 600 "$out"',
        'echo ok'
      ].join("\n")
      return ["bash", "-c", script, "jh-netrc", netrcPath, tokenFile, user, jenkinsUrl]
    }

    function onNetrcExit(text) {
      if (String(text || "").trim() !== "ok") {
        stateName = "noauth"
        statusMessage = "cannot read the API token or write the netrc file — see README"
        return
      }
      netrcOk = true
      statusMessage = ""
      poll()
      pollTimer.restart()
    }

    function poll() {
      if (busy || !jenkinsUrl || !netrcOk) return
      busy = true
      pollGeneration = generation
      fetched = ({})
      stepIndex = 0
      fetchStep()
    }

    function fetchStep() {
      if (stepIndex < 0 || stepIndex >= steps.length) {
        finalize()
        return
      }
      var step = steps[stepIndex]
      var args = Model.buildCurlArgs(step.endpoint, "GET", jenkinsUrl, netrcPath, null)
      args.push("-D", "-") // response headers on stdout: X-Jenkins version
      fetchProcess.command = args
      fetchProcess.running = true
    }

    function onFetchExit(exitCode, text) {
      if (generation !== pollGeneration) {
        // Config changed mid-flight; drop the stale cycle.
        busy = false
        return
      }

      var step = steps[Math.max(0, Math.min(stepIndex, steps.length - 1))]
      var header = ""
      var body = String(text || "")
      var split = body.indexOf("\r\n\r\n")
      if (split !== -1) {
        header = body.substring(0, split)
        body = body.substring(split + 4)
      }

      if (exitCode === 0) {
        try {
          fetched[step.key] = JSON.parse(body)
        } catch (e) {
          fetched[step.key] = null
        }
        if (step.key === "api") {
          var m = header.match(/X-Jenkins:[ \t]*([^\r\n]+)/i)
          fetched.apiHeader = m ? m[1].trim() : ""
        }
      } else {
        fetched[step.key] = null
      }

      if (step.key === "api" && !fetched.api) {
        // The controller is not answering with JSON. curl -D - still
        // delivers response headers on HTTP failures, so the status line
        // tells an auth rejection or a mis-set URL apart from an outage.
        var sm = header.match(/^HTTP\/[\d.]+[ \t]+(\d{3})/)
        var code = sm ? parseInt(sm[1], 10) : 0
        if (code === 401 || code === 403) {
          busy = false
          stateName = "noauth"
          statusMessage = "Jenkins rejected the credentials (HTTP " + code + ") — check jenkinsUser and the token file"
          // Re-baseline: never diff events across a blind window.
          prevSnapshot = null
          return
        }
        if (code >= 300 && code < 400) {
          busy = false
          stateName = "unconfigured"
          statusMessage = "Jenkins redirected (HTTP " + code + ") — check the jenkinsUrl scheme"
          prevSnapshot = null
          return
        }
        // Controller unreachable: skip the rest of the cycle.
        stepIndex = steps.length
        finalize()
        return
      }

      stepIndex += 1
      fetchStep()
    }

    function finalize() {
      busy = false

      var controller = fetched.api ? Model.parseController(fetched.api, fetched.apiHeader || "") : null
      var nodesParsed = fetched.computer ? Model.parseNodes(fetched.computer) : null
      var queueParsed = fetched.queue ? Model.parseQueue(fetched.queue) : null
      var pluginsParsed = fetched.plugins ? Model.parsePlugins(fetched.plugins) : null
      var ucParsed = fetched.uc ? Model.parseUpdateCenter(fetched.uc) : null

      var snap = Model.assess(controller, nodesParsed, queueParsed, pluginsParsed, ucParsed, root.config, Date.now())
      var events = Model.diffEvents(prevSnapshot, snap, root.config)

      queueItems = queueParsed ? queueParsed.items : []
      snapshot = snap
      prevSnapshot = snap
      stateName = snap.overall.level
      statusMessage = ""

      var d = new Date()
      lastUpdatedText = ("0" + d.getHours()).slice(-2) + ":" +
        ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2)

      for (var i = 0; i < events.length; i++) notifyEvent(events[i])
    }

    function notifyEvent(ev) {
      var glyphs = {
        "controller-down": "󰅙", "controller-up": "󰄬",
        "node-offline": "󰅙", "node-online": "󰄬",
        "job-failure": "󰅙", "job-recovered": "󰄬",
        "queue-backlog": "󰦖", "queue-clear": "󰄬",
        "maintenance": "󰢌"
      }
      var headlines = {
        "controller-down": "Jenkins controller down",
        "controller-up": "Jenkins controller up",
        "node-offline": "Jenkins node offline",
        "node-online": "Jenkins node online",
        "job-failure": "Jenkins job failure",
        "job-recovered": "Jenkins jobs recovered",
        "queue-backlog": "Jenkins queue backlog",
        "queue-clear": "Jenkins queue clear",
        "maintenance": "Jenkins maintenance"
      }
      var urgency = ev.severity === "critical" ? "critical"
        : (ev.severity === "warn" || ev.severity === "error") ? "normal" : "low"
      var bin = (root.omarchyPath || "/usr/share/omarchy") + "/bin/omarchy-notification-send"
      Quickshell.execDetached([
        bin, "-g", glyphs[ev.type] || "󰢌", "-u", urgency,
        headlines[ev.type] || "Jenkins", ev.message
      ])
    }

    function runAction(action, targetId) {
      if (!jenkinsUrl || !netrcOk) return
      pendingAction = (action && typeof action === "object")
        ? action
        : { action: String(action || ""), targetId: targetId }
      actionMessage = "running action…"
      crumbProcess.command = Model.buildCurlArgs("/crumbIssuer/api/json", "GET", jenkinsUrl, netrcPath, null)
      crumbProcess.running = true
    }

    function onCrumbExit(exitCode, text) {
      var crumb = ""
      if (exitCode === 0) {
        try {
          var doc = JSON.parse(String(text || ""))
          crumb = doc && doc.crumb ? String(doc.crumb) : ""
        } catch (e) {
          crumb = ""
        }
      }
      var act = pendingAction
      pendingAction = null
      if (!act) return
      actionProcess.command = Model.buildActionCommand(act, act.targetId, jenkinsUrl, netrcPath, crumb)
      actionProcess.running = true
    }

    function onActionExit(exitCode) {
      actionMessage = exitCode === 0
        ? "action sent"
        : "action failed (exit " + exitCode + ")"
      actionRefreshTimer.restart()
    }
  }

  property Process netrcProcess: Process {
    stdout: StdioCollector { id: netrcOut; waitForEnd: true }
    onExited: function(exitCode) { internal.onNetrcExit(netrcOut.text || "") }
  }

  property Process fetchProcess: Process {
    stdout: StdioCollector { id: fetchOut; waitForEnd: true }
    onExited: function(exitCode) { internal.onFetchExit(exitCode, fetchOut.text || "") }
  }

  property Process crumbProcess: Process {
    stdout: StdioCollector { id: crumbOut; waitForEnd: true }
    onExited: function(exitCode) { internal.onCrumbExit(exitCode, crumbOut.text || "") }
  }

  property Process actionProcess: Process {
    stdout: StdioCollector { id: actionOut; waitForEnd: true }
    onExited: function(exitCode) { internal.onActionExit(exitCode) }
  }

  property Timer pollTimer: Timer {
    interval: Math.max(5, (root.config && root.config.refreshIntervalSec) || 30) * 1000
    repeat: true
    running: false
    onTriggered: internal.poll()
  }

  property Timer actionRefreshTimer: Timer {
    interval: 1200
    repeat: false
    onTriggered: internal.poll()
  }

  // IPC surface for scripts and other plugins:
  //   qs ipc call jenkins-health refresh
  //   qs ipc call jenkins-health status
  //   qs ipc call jenkins-health open | close | toggle   (detail panel)
  // Lives on the service (a single instance) so a multi-monitor bar can
  // never collide on the target name; panel commands relay to every
  // registered widget.
  IpcHandler {
    target: "jenkins-health"

    function refresh(): string {
      root.refresh()
      return "ok"
    }

    function open(): string {
      root.relayToWidgets("openPopup")
      return "ok"
    }

    function close(): string {
      root.relayToWidgets("closePopup")
      return "ok"
    }

    function toggle(): string {
      root.relayToWidgets("togglePopup")
      return "ok"
    }

    function status(): string {
      return JSON.stringify({
        state: root.state,
        level: root.level,
        score: root.score,
        version: root.version,
        updated: root.lastUpdated,
        message: root.statusMessage
      })
    }
  }
}
