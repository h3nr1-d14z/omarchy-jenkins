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
  // Workspace dry-run for the node last asked to clean: {node, dirs, error}
  // or null. Set by nodeWorkspaceList, cleared by clean/confirm-dismiss.
  readonly property var workspacePreview: internal.workspacePreview
  // Time series for the panel sparklines (persisted across restarts;
  // see the history section in Model.js for the retention policy).
  readonly property var historyPts: internal.historyPts
  readonly property var historyDisks: internal.historyDisks


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
  //                 "nodeOffline" | "nodeOnline" |
  //                 "nodeWorkspaceList" | "nodeWorkspaceClean") or
  // descriptor object.
  function runAction(action, targetId) {
    internal.runAction(action, targetId)
  }

  function clearWorkspacePreview() {
    internal.workspacePreview = null
  }

  Component.onCompleted: internal.loadHistory()

  QtObject {
    id: internal

    property string stateName: "unconfigured"
    property var snapshot: null
    property var prevSnapshot: null
    property var queueItems: []
    property string lastUpdatedText: ""
    property string statusMessage: ""
    property string actionMessage: ""
    property var workspacePreview: null
    property string lastActionKind: ""
    property string lastActionTarget: ""
    property var diskUnknownStreak: ({})
    property var diskUnknownAnnounced: ({})
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
    property var historyPts: []
    property var historyDisks: ({})
    property string historyPath: ""
    property bool historyLoaded: false


    readonly property var steps: [
      // Tree query: jobs three levels deep, colors plus the extended
      // per-leaf data (Jenkins healthReport score, last build, last
      // successful build). Model.parseController flattens the nesting;
      // a plain /api/json lists only top-level folders, whose color is
      // null — on folder-organized controllers that keeps the failures
      // feed real, and the extended fields power the Jobs detail rows,
      // the Activity feed and the never-green detection.
      // Brackets are percent-encoded: curl treats literal [] in a URL as
      // glob ranges (exit 3) unless --globoff; Jenkins accepts %5B/%5D.
      { endpoint: "/api/json?tree=jobs%5Bname,color,healthReport%5Bscore,description%5D,lastBuild%5Bnumber,timestamp,duration,result,building%5D,lastSuccessfulBuild%5Bnumber,timestamp,duration%5D,jobs%5Bname,color,healthReport%5Bscore,description%5D,lastBuild%5Bnumber,timestamp,duration,result,building%5D,lastSuccessfulBuild%5Bnumber,timestamp,duration%5D,jobs%5Bname,color,healthReport%5Bscore,description%5D,lastBuild%5Bnumber,timestamp,duration,result,building%5D,lastSuccessfulBuild%5Bnumber,timestamp,duration%5D%5D%5D%5D,mode,quietingDown,useCrumbs,useSecurity,numExecutors", key: "api" },
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

    // ---- history persistence (score/queue/disk time series)
    // The cache file is regenerable, so ~/.cache is the right home; a
    // corrupt or absent file just starts an empty history.

    function loadHistory() {
      // The default path sits under ~/.cache (regenerable) and can be
      // overridden with JH_HISTORY_PATH so test shells never touch the
      // real history. Read via cat: FileView loads async, so text()
      // right after assigning path reliably returns "" (every restore
      // silently failed that way); a Process exit is deterministic.
      var override = Quickshell.env("JH_HISTORY_PATH") || ""
      historyPath = override ? override
        : expandTilde("~/.cache/jenkins-health/history.json")
      historyReadProcess.command = [
        "bash", "-c", 'cat "$1" 2>/dev/null || true', "jh-history-read", historyPath
      ]
      historyReadProcess.running = true
    }

    function onHistoryReadExit(text) {
      // Always latch the flag: a missing or corrupt cache just means an
      // empty history, and finalize() only appends once the (possibly
      // empty) prior state is known.
      historyLoaded = true
      var doc = null
      try {
        doc = JSON.parse(String(text || ""))
      } catch (e) {
        doc = null
      }
      if (doc && typeof doc === "object" && doc.v === 1) {
        historyPts = Array.isArray(doc.pts) ? doc.pts : []
        historyDisks = doc.disks && typeof doc.disks === "object" && !Array.isArray(doc.disks)
          ? doc.disks : ({})
      }
    }

    function persistHistory() {
      // Best-effort: skip when a write is in flight — the next poll's
      // point carries the state forward anyway. The JSON reaches bash
      // as a positional argument (never interpolated into the script),
      // and the file is world-inaccessible (umask 077).
      if (!historyPath || historyWriteProcess.running) return
      historyWriteProcess.command = [
        "bash", "-c",
        'umask 077\nmkdir -p "${2%/*}" 2>/dev/null || true\nprintf %s "$1" > "$2"',
        "jh-history",
        JSON.stringify({ v: 1, pts: historyPts, disks: historyDisks }),
        historyPath
      ]
      historyWriteProcess.running = true
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

      // History: one point per successful poll; compaction keeps the
      // persisted cache small and bounded (see Model.js). Skipped until
      // the startup read latched, so no point lands on an unloaded
      // prior state.
      if (historyLoaded) {
        var tSec = Math.floor(Date.now() / 1000)
        historyPts = Model.historyCompactPts(
          Model.historyAppendPt(historyPts, tSec, snap.overall.score, snap.queue.depth), tSec)
        var disksNext = historyDisks
        for (var h = 0; h < snap.nodes.length; h++) {
          disksNext = Model.historyAppendDisk(disksNext,
            snap.nodes[h].displayName, tSec, snap.nodes[h].diskGb)
        }
        historyDisks = Model.historyCompactDisks(disksNext, tSec)
        persistHistory()
      }

      for (var i = 0; i < events.length; i++) notifyEvent(events[i])

      // Disk-unknown debounce: node monitors report null for a poll or
      // two after every agent reconnect (NodeMonitor computes on a ~1min
      // period). diffEvents deliberately does not edge on "unknown";
      // announce only after the node has been online-with-null-monitors
      // for K consecutive polls, and recover when it reports again.
      updateDiskUnknown(snap)
    }

    function updateDiskUnknown(snap) {
      // notifyNodes covers this event class too: the bookkeeping below
      // always runs (state stays correct if the category is re-enabled),
      // only the toasts are suppressed.
      var on = !root.config || root.config.notifyNodes !== false
      var K = 2
      var nextStreak = {}
      var nextAnnounced = {}
      var nodes = Array.isArray(snap.nodes) ? snap.nodes : []
      for (var u = 0; u < nodes.length; u++) {
        var un = nodes[u]
        var name = un.displayName
        var streak = 0
        var was = diskUnknownAnnounced[name] === true
        if (un.state === "online" && un.diskTier === "unknown") {
          streak = (diskUnknownStreak[name] || 0) + 1
          if (streak === K && !was) {
            was = true
            if (on) notifyEvent({
              type: "node-disk-unknown",
              severity: "warn",
              message: "Node " + name + " disk state unknown (monitors not reporting)"
            })
          }
        } else if (was && un.state === "online") {
          // was announced, now reporting values again while online
          was = false
          if (on) notifyEvent({
            type: "node-disk-ok",
            severity: "info",
            message: "Node " + name + " disk monitors reporting again"
          })
        } else {
          // offline or disappeared: silently clear, offline values are
          // stale by definition and going offline already notified
          was = false
        }
        nextStreak[name] = streak
        nextAnnounced[name] = was
      }
      diskUnknownStreak = nextStreak
      diskUnknownAnnounced = nextAnnounced
    }

    function notifyEvent(ev) {
      var glyphs = {
        "controller-down": "󰅙", "controller-up": "󰄬",
        "node-offline": "󰅙", "node-online": "󰄬",
        "node-disk-low": "󰉋", "node-disk-critical": "󰉋",
        "node-disk-unknown": "󰉋", "node-disk-ok": "󰄬",
        "job-failure": "󰅙", "job-recovered": "󰄬",
        "queue-backlog": "󰦖", "queue-clear": "󰄬",
        "maintenance": "󰢌"
      }
      var headlines = {
        "controller-down": "Jenkins controller down",
        "controller-up": "Jenkins controller up",
        "node-offline": "Jenkins node offline",
        "node-online": "Jenkins node online",
        "node-disk-low": "Jenkins node disk low",
        "node-disk-critical": "Jenkins node disk critical",
        "node-disk-unknown": "Jenkins node disk unknown",
        "node-disk-ok": "Jenkins node disk recovered",
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
      lastActionKind = String(pendingAction.action || "")
      lastActionTarget = pendingAction.targetId !== undefined && pendingAction.targetId !== null
        ? String(pendingAction.targetId) : ""
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

    function onActionExit(exitCode, text) {
      if (lastActionKind === "nodeWorkspaceList") {
        workspacePreview = parseWorkspaceList(exitCode, scriptBody(text))
        actionMessage = exitCode === 0
          ? "workspace list loaded"
          : "workspace list failed (exit " + exitCode + ")"
      } else if (lastActionKind === "nodeWorkspaceClean") {
        actionMessage = parseWorkspaceClean(exitCode, scriptBody(text))
        workspacePreview = null
      } else {
        actionMessage = exitCode === 0
          ? "action sent"
          : "action failed (exit " + exitCode + ")"
      }
      actionRefreshTimer.restart()
    }

    // /scriptText answers plain text on this controller but is JSON
    // {result: "..."} elsewhere — accept both.
    function scriptBody(text) {
      var body = String(text || "")
      try {
        var doc = JSON.parse(body)
        if (doc && typeof doc.result === "string") body = doc.result
      } catch (e) {}
      return body
    }

    function parseWorkspaceList(exitCode, body) {
      var node = lastActionTarget
      if (exitCode !== 0) {
        var denied = /administer|script console|RunScripts|403/i.test(String(body || ""))
        return { node: node, dirs: [],
          error: denied ? "no script-console permission — the token must be admin-scoped" : "request failed" }
      }
      var lines = body.split("\n")
      var verdicts = ["NO_SUCH_COMPUTER", "NODE_OFFLINE", "NODE_BUSY", "NO_WORKSPACE_ROOT"]
      var first = String(lines[0] || "").trim()
      if (verdicts.indexOf(first) !== -1) {
        return { node: node, dirs: [], error: first }
      }
      var dirs = []
      for (var i = 0; i < lines.length; i++) {
        var line = String(lines[i] || "")
        if (line.indexOf("DIR ") === 0) dirs.push(line.slice(4).trim())
      }
      return { node: node, dirs: dirs, error: "" }
    }

    function parseWorkspaceClean(exitCode, body) {
      if (exitCode !== 0) {
        var denied = /administer|script console|RunScripts|403/i.test(String(body || ""))
        return denied
          ? "workspace clean failed — no script-console permission (token must be admin-scoped)"
          : "workspace clean failed (exit " + exitCode + ")"
      }
      var lines = body.split("\n")
      var verdicts = {
        "NO_SUCH_COMPUTER": "node not found — nothing deleted",
        "NODE_OFFLINE": "node offline — nothing deleted",
        "NODE_BUSY": "node busy — nothing deleted",
        "NO_WORKSPACE_ROOT": "no workspace root — nothing deleted"
      }
      var first = String(lines[0] || "").trim()
      if (verdicts[first]) return verdicts[first]
      for (var i = 0; i < lines.length; i++) {
        var line = String(lines[i] || "")
        if (line.indexOf("RESULT ") === 0) {
          var parts = line.slice(7).trim().split(/\s+/)
          var out = {}
          for (var p = 0; p < parts.length; p++) {
            var kv = parts[p].split("=")
            out[kv[0]] = kv[1]
          }
          return "deleted " + (out.deleted || 0) + " workspace dirs (skipped "
            + (out.skipped || 0) + ", failed " + (out.errors || 0) + ")"
        }
      }
      return "workspace clean finished (unexpected response)"
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
    onExited: function(exitCode) { internal.onActionExit(exitCode, actionOut.text || "") }
  }

  property Process historyWriteProcess: Process {
    stdout: StdioCollector { waitForEnd: true }
    // Best-effort cache write; failures surface nowhere by design.
    onExited: function(exitCode) {}
  }

  property Process historyReadProcess: Process {
    stdout: StdioCollector { id: historyReadOut; waitForEnd: true }
    onExited: function(exitCode) { internal.onHistoryReadExit(historyReadOut.text || "") }
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
