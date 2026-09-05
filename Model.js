// Model.js — pure data layer for the Jenkins Health plugin (h3nr1.d14z.jenkins).
//
// QML usage:      import "Model.js" as Model
// Node (tests):   required via the CommonJS guard at the bottom.
//
// Every function is pure: fresh return values, arguments never mutated,
// malformed input degrades to sane defaults instead of throwing.

// ---------------------------------------------------------------- helpers

function jhIsObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function jhStr(value, fallback) {
  return typeof value === "string" ? value : fallback
}

function jhNum(value, fallback) {
  return typeof value === "number" && isFinite(value) ? value : fallback
}

function jhGbLabel(gb) {
  return (Math.round(gb * 10) / 10) + " GB"
}

function jhHostOf(jenkinsUrl) {
  var s = String(jenkinsUrl || "")
  s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "") // strip scheme
  s = s.replace(/\/.*$/, "") // strip path
  s = s.replace(/:\d+$/, "") // strip port
  return s || "localhost"
}

function jhJoinUrl(base, endpoint) {
  var b = String(base || "").replace(/\/+$/, "")
  var e = String(endpoint || "")
  if (e.charAt(0) !== "/") e = "/" + e
  return b + e
}

// ---------------------------------------------------------------- parsing

function parseController(apiJson, xJenkinsHeader) {
  if (!jhIsObject(apiJson)) {
    return {
      version: "Unknown",
      mode: "UNKNOWN",
      quietingDown: false,
      useCrumbs: false,
      useSecurity: false,
      numExecutors: 0,
      jobs: []
    }
  }

  var header = typeof xJenkinsHeader === "string" ? xJenkinsHeader.trim() : ""
  var jobs = []
  var rawJobs = Array.isArray(apiJson.jobs) ? apiJson.jobs : []
  for (var i = 0; i < rawJobs.length; i++) {
    var j = rawJobs[i]
    if (jhIsObject(j)) {
      jobs.push({ name: jhStr(j.name, ""), color: jhStr(j.color, "") })
    }
  }

  return {
    version: header || "Unknown",
    mode: jhStr(apiJson.mode, "UNKNOWN"),
    quietingDown: !!apiJson.quietingDown,
    useCrumbs: !!apiJson.useCrumbs,
    useSecurity: !!apiJson.useSecurity,
    numExecutors: jhNum(apiJson.numExecutors, 0),
    jobs: jobs
  }
}

function parseNodes(computerJson) {
  if (!jhIsObject(computerJson) || !Array.isArray(computerJson.computer)) {
    return { total: 0, online: 0, offline: 0, temporarilyOffline: 0, nodes: [] }
  }

  var nodes = []
  var online = 0
  var tempOffline = 0

  for (var i = 0; i < computerJson.computer.length; i++) {
    var c = computerJson.computer[i]
    if (!jhIsObject(c)) continue

    var md = jhIsObject(c.monitorData) ? c.monitorData : {}
    var disk = jhIsObject(md["hudson.node_monitors.DiskSpaceMonitor"])
      ? md["hudson.node_monitors.DiskSpaceMonitor"] : null
    var temp = jhIsObject(md["hudson.node_monitors.TemporarySpaceMonitor"])
      ? md["hudson.node_monitors.TemporarySpaceMonitor"] : null
    var rt = jhIsObject(md["hudson.node_monitors.ResponseTimeMonitor"])
      ? md["hudson.node_monitors.ResponseTimeMonitor"] : null

    var executors = Array.isArray(c.executors) ? c.executors : []
    var busy = 0
    for (var e = 0; e < executors.length; e++) {
      if (jhIsObject(executors[e]) && executors[e].idle === false) busy++
    }

    var isTemp = !!c.temporarilyOffline
    var isOffline = !!c.offline || isTemp
    if (isTemp) tempOffline++
    if (!isOffline) online++

    nodes.push({
      displayName: jhStr(c.displayName, ""),
      offline: !!c.offline,
      temporarilyOffline: isTemp,
      offlineCauseReason: jhStr(c.offlineCauseReason, ""),
      diskBytes: disk ? jhNum(disk.size, null) : null,
      tempBytes: temp ? jhNum(temp.size, null) : null,
      responseTimeMs: rt ? jhNum(rt.average, null) : null,
      architecture: jhStr(md["hudson.node_monitors.ArchitectureMonitor"], null),
      executorsTotal: executors.length,
      executorsIdle: executors.length - busy
    })
  }

  return {
    total: nodes.length,
    online: online,
    offline: nodes.length - online,
    temporarilyOffline: tempOffline,
    nodes: nodes
  }
}

function parseQueue(queueJson) {
  if (!jhIsObject(queueJson) || !Array.isArray(queueJson.items)) {
    return { depth: 0, stuck: 0, items: [] }
  }

  var items = []
  var stuck = 0

  for (var i = 0; i < queueJson.items.length; i++) {
    var it = queueJson.items[i]
    if (!jhIsObject(it)) continue
    var task = jhIsObject(it.task) ? it.task : {}
    var isStuck = !!it.stuck
    if (isStuck) stuck++
    items.push({
      id: it.id,
      name: jhStr(task.name, ""),
      why: jhStr(it.why, ""),
      inQueueSince: jhNum(it.inQueueSince, 0),
      stuck: isStuck
    })
  }

  return { depth: items.length, stuck: stuck, items: items }
}

function parsePlugins(pluginManagerJson) {
  if (!jhIsObject(pluginManagerJson) || !Array.isArray(pluginManagerJson.plugins)) {
    return { total: 0, updatesAvailable: 0, plugins: [] }
  }

  var plugins = []
  var updates = 0

  for (var i = 0; i < pluginManagerJson.plugins.length; i++) {
    var p = pluginManagerJson.plugins[i]
    if (!jhIsObject(p)) continue
    var hasUpdate = !!p.hasUpdate
    if (hasUpdate) updates++
    plugins.push({
      shortName: jhStr(p.shortName, ""),
      version: jhStr(p.version, ""),
      hasUpdate: hasUpdate,
      active: !!p.active,
      enabled: !!p.enabled,
      deprecated: !!p.deprecated
    })
  }

  return { total: plugins.length, updatesAvailable: updates, plugins: plugins }
}

function parseUpdateCenter(updateCenterJson) {
  if (!jhIsObject(updateCenterJson)) {
    return { restartRequired: false, jobs: [], warnings: [] }
  }
  return {
    restartRequired: !!updateCenterJson.restartRequiredForCompletion,
    jobs: Array.isArray(updateCenterJson.jobs) ? updateCenterJson.jobs : [],
    warnings: Array.isArray(updateCenterJson.warnings) ? updateCenterJson.warnings : []
  }
}

// ------------------------------------------------------------- assessment

// Score penalties (subtracted from 100):
//   offline node 8   slow node 4   online disk-critical 10   backlog 8
//   stuck item 4     red job 6     unstable>=2 4             updates 2
//   restart required 2
// Levels: score >= 95 "ok", >= 50 "warn", else "critical".
function assess(controller, nodes, queue, plugins, updateCenter, config, now) {
  var cfg = jhIsObject(config) ? config : {}
  var queueThreshold = jhNum(cfg.queueBacklogThreshold, 10)
  var diskWarnGb = jhNum(cfg.diskWarnGb, 25)
  var diskCriticalGb = jhNum(cfg.diskCriticalGb, 10)
  var rttWarnMs = jhNum(cfg.responseTimeWarnMs, 1000)

  var parsedNodes = jhIsObject(nodes) && Array.isArray(nodes.nodes)
    ? nodes : { total: 0, online: 0, offline: 0, temporarilyOffline: 0, nodes: [] }
  var parsedQueue = jhIsObject(queue) ? queue : { depth: 0, stuck: 0, items: [] }
  var parsedPlugins = jhIsObject(plugins) ? plugins : { total: 0, updatesAvailable: 0, plugins: [] }
  var parsedUc = jhIsObject(updateCenter) ? updateCenter : { restartRequired: false, jobs: [], warnings: [] }

  // --- controller unreachable: everything else is moot
  if (!jhIsObject(controller)) {
    return {
      controller: {
        status: "unreachable", level: "critical", healthScore: 0,
        reasons: ["controller unreachable"],
        failures: 0, unstable: 0, building: 0, quietingDown: false,
        failingNames: [], unstableNames: [], buildingNames: []
      },
      nodes: [],
      queue: { depth: 0, stuck: 0, backlog: false, oldestSec: 0 },
      maintenance: { quietingDown: false, restartRequired: false, updatesAvailable: 0 },
      overall: { level: "critical", score: 0, reasons: ["controller unreachable"] }
    }
  }

  // --- jobs by ball color
  var jobs = Array.isArray(controller.jobs) ? controller.jobs : []
  var failingNames = [], unstableNames = [], buildingNames = []
  var redCount = 0, yellowCount = 0, animeCount = 0
  for (var i = 0; i < jobs.length; i++) {
    var color = jobs[i].color
    var name = jobs[i].name
    if (color === "blue") {
      // healthy
    } else if (color === "blue_anime") {
      animeCount++
      buildingNames.push(name)
    } else if (color === "yellow" || color === "yellow_anime") {
      yellowCount++
      unstableNames.push(name)
    } else if (color === "red" || color === "red_anime") {
      redCount++
      failingNames.push(name)
    }
  }

  // --- node assessment
  var nodeOut = []
  var overallReasons = []
  var offlineNodes = 0
  var diskCriticalOnline = 0
  var slowNodes = 0
  var score = 100

  for (var n = 0; n < parsedNodes.nodes.length; n++) {
    var node = parsedNodes.nodes[n]
    var isOffline = !!node.offline || !!node.temporarilyOffline
    var diskGb = node.diskBytes !== null && node.diskBytes !== undefined
      ? node.diskBytes / 1e9 : null
    var reasons = []
    var level = "ok"

    if (isOffline) {
      offlineNodes++
      var cause = node.offlineCauseReason
        ? node.offlineCauseReason
        : (node.temporarilyOffline ? "temporarily offline" : "offline")
      reasons.push("offline: " + cause)
      level = "warn"
      overallReasons.push("node " + node.displayName + " offline — " + cause)
    }

    if (diskGb !== null && diskGb < diskCriticalGb) {
      reasons.push("disk space critical: " + jhGbLabel(diskGb) + " free")
      level = "critical"
      if (!isOffline) diskCriticalOnline++
      overallReasons.push("node " + node.displayName + " disk space critical: " + jhGbLabel(diskGb) + " free")
    } else if (diskGb !== null && diskGb < diskWarnGb) {
      reasons.push("disk space low: " + jhGbLabel(diskGb) + " free")
      if (level === "ok") level = "warn"
      overallReasons.push("node " + node.displayName + " disk space low: " + jhGbLabel(diskGb) + " free")
    }

    if (!isOffline && node.responseTimeMs !== null && node.responseTimeMs !== undefined
        && node.responseTimeMs > rttWarnMs) {
      slowNodes++
      reasons.push("response time " + node.responseTimeMs + " ms above " + rttWarnMs + " ms")
      if (level === "ok") level = "warn"
      overallReasons.push("node " + node.displayName + " response time " + node.responseTimeMs + " ms above " + rttWarnMs + " ms")
    }

    nodeOut.push({
      displayName: node.displayName,
      state: isOffline ? "offline" : "online",
      diskGb: diskGb,
      responseTimeMs: node.responseTimeMs,
      executorsTotal: node.executorsTotal,
      executorsIdle: node.executorsIdle,
      utilization: node.executorsTotal > 0
        ? (node.executorsTotal - node.executorsIdle) / node.executorsTotal : 0,
      level: level,
      reasons: reasons
    })
  }

  if (offlineNodes > 0) score -= 8 * offlineNodes
  if (diskCriticalOnline > 0) score -= 10 * diskCriticalOnline
  if (slowNodes > 0) score -= 4 * slowNodes

  // --- queue assessment
  var depth = jhNum(parsedQueue.depth, 0)
  var stuck = jhNum(parsedQueue.stuck, 0)
  var backlog = depth > queueThreshold
  var oldestSec = 0
  var items = Array.isArray(parsedQueue.items) ? parsedQueue.items : []
  for (var q = 0; q < items.length; q++) {
    if (items[q] && typeof items[q].inQueueSince === "number") {
      var age = Math.round(((jhNum(now, 0)) - items[q].inQueueSince) / 1000)
      if (age > oldestSec) oldestSec = age
    }
  }
  if (backlog) {
    score -= 8
    overallReasons.push("queue backlog: " + depth + " items waiting (threshold " + queueThreshold + ")")
  }
  if (stuck > 0) {
    score -= 4 * stuck
    overallReasons.push(stuck + (stuck === 1 ? " queue item is stuck" : " queue items are stuck"))
  }

  // --- job assessment
  if (redCount > 0) {
    score -= 6 * redCount
    var failMsg = redCount + (redCount === 1 ? " job failing" : " jobs failing")
    if (failingNames.length > 0) failMsg += " (" + failingNames.join(", ") + ")"
    overallReasons.push(failMsg)
  }
  if (yellowCount >= 2) {
    score -= 4
    overallReasons.push(yellowCount + " unstable jobs")
  }

  // --- maintenance assessment
  var updatesAvailable = jhNum(parsedPlugins.updatesAvailable, 0)
  var restartRequired = !!parsedUc.restartRequired
  var quietingDown = !!controller.quietingDown
  if (updatesAvailable > 0) {
    score -= 2
    overallReasons.push(updatesAvailable + " plugin updates available")
  }
  if (restartRequired) {
    score -= 2
    overallReasons.push("restart required to complete plugin updates")
  }
  if (quietingDown) {
    overallReasons.push("quiet-down active: Jenkins is preparing to shut down")
  }

  // --- controller sub-score (jobs + quieting only)
  var controllerScore = 100 - 6 * redCount - (yellowCount >= 2 ? 4 : 0)
  var controllerReasons = []
  if (redCount > 0) {
    controllerReasons.push(redCount + (redCount === 1 ? " job failing" : " jobs failing"))
  }
  if (yellowCount >= 2) controllerReasons.push(yellowCount + " unstable jobs")
  if (quietingDown) controllerReasons.push("quiet-down active")

  score = Math.max(0, Math.min(100, score))
  controllerScore = Math.max(0, Math.min(100, controllerScore))

  return {
    controller: {
      status: "up",
      level: controllerScore >= 95 ? "ok" : controllerScore >= 50 ? "warn" : "critical",
      healthScore: controllerScore,
      reasons: controllerReasons,
      version: controller.version,
      mode: controller.mode,
      failures: redCount,
      unstable: yellowCount,
      building: animeCount,
      quietingDown: quietingDown,
      failingNames: failingNames,
      unstableNames: unstableNames,
      buildingNames: buildingNames
    },
    nodes: nodeOut,
    queue: {
      depth: depth,
      stuck: stuck,
      backlog: backlog,
      oldestSec: oldestSec
    },
    maintenance: {
      quietingDown: quietingDown,
      restartRequired: restartRequired,
      updatesAvailable: updatesAvailable
    },
    overall: {
      level: score >= 95 ? "ok" : score >= 50 ? "warn" : "critical",
      score: score,
      reasons: overallReasons
    }
  }
}

// ------------------------------------------------------------ event diffing

// Edge-triggered notification events between two assess() snapshots.
// Event types: controller-down, controller-up, node-offline, node-online,
// job-failure, job-recovered, queue-backlog, queue-clear, maintenance.
// config toggles: notifyController, notifyNodes, notifyFailures,
// notifyQueue, notifyMaintenance (false disables that category).
function diffEvents(prevSnapshot, nextSnapshot, config) {
  if (!prevSnapshot || !nextSnapshot) return []

  var cfg = jhIsObject(config) ? config : {}
  var notifyController = cfg.notifyController !== false
  var notifyNodes = cfg.notifyNodes !== false
  var notifyFailures = cfg.notifyFailures !== false
  var notifyQueue = cfg.notifyQueue !== false
  var notifyMaintenance = cfg.notifyMaintenance !== false

  var events = []
  var prevC = jhIsObject(prevSnapshot.controller) ? prevSnapshot.controller : {}
  var nextC = jhIsObject(nextSnapshot.controller) ? nextSnapshot.controller : {}
  var prevUp = prevC.status !== "unreachable"
  var nextUp = nextC.status !== "unreachable"

  // controller down / up
  if (prevUp && !nextUp && notifyController) {
    events.push({
      type: "controller-down",
      severity: "critical",
      message: "Jenkins controller unreachable"
    })
  } else if (!prevUp && nextUp && notifyController) {
    events.push({
      type: "controller-up",
      severity: "info",
      message: "Jenkins controller is back up"
    })
  }

  // node state changes (matched by displayName, both snapshots reachable)
  if (notifyNodes && prevUp && nextUp) {
    var prevMap = {}
    var prevNodes = Array.isArray(prevSnapshot.nodes) ? prevSnapshot.nodes : []
    for (var i = 0; i < prevNodes.length; i++) {
      prevMap[prevNodes[i].displayName] = prevNodes[i].state
    }
    var nextMap = {}
    var nextNodes = Array.isArray(nextSnapshot.nodes) ? nextSnapshot.nodes : []
    for (var j = 0; j < nextNodes.length; j++) {
      nextMap[nextNodes[j].displayName] = nextNodes[j]
    }
    for (var name in prevMap) {
      var nextState = nextMap[name] ? nextMap[name].state : undefined
      if (prevMap[name] === "online" && nextState === "offline") {
        var cause = nextMap[name].reasons && nextMap[name].reasons.length > 0
          ? " (" + nextMap[name].reasons.join("; ") + ")" : ""
        events.push({
          type: "node-offline",
          severity: "warn",
          message: "Node " + name + " went offline" + cause
        })
      } else if (prevMap[name] === "offline" && nextState === "online") {
        events.push({
          type: "node-online",
          severity: "info",
          message: "Node " + name + " is back online"
        })
      }
    }
  }

  // job failures
  if (notifyFailures) {
    var prevF = jhNum(prevC.failures, 0)
    var nextF = jhNum(nextC.failures, 0)
    if (nextF > prevF) {
      var msg = nextF + (nextF === 1 ? " job is failing" : " jobs are failing")
      if (Array.isArray(nextC.failingNames) && nextC.failingNames.length > 0) {
        msg += " (" + nextC.failingNames.join(", ") + ")"
      }
      events.push({ type: "job-failure", severity: "warn", message: msg })
    } else if (nextF < prevF) {
      var recovered = nextF === 0
        ? "All jobs are healthy again"
        : "Jobs recovered: " + prevF + " → " + nextF + " still failing"
      events.push({ type: "job-recovered", severity: "info", message: recovered })
    }
  }

  // queue backlog transitions
  if (notifyQueue) {
    var prevQ = jhIsObject(prevSnapshot.queue) ? prevSnapshot.queue : {}
    var nextQ = jhIsObject(nextSnapshot.queue) ? nextSnapshot.queue : {}
    if (!prevQ.backlog && nextQ.backlog) {
      events.push({
        type: "queue-backlog",
        severity: "warn",
        message: "Build queue backlog: " + jhNum(nextQ.depth, 0) + " items waiting"
      })
    } else if (prevQ.backlog && !nextQ.backlog) {
      events.push({ type: "queue-clear", severity: "info", message: "Build queue backlog cleared" })
    }
  }

  // maintenance: quiet-down, restart, plugin updates
  if (notifyMaintenance) {
    var prevM = jhIsObject(prevSnapshot.maintenance) ? prevSnapshot.maintenance : {}
    var nextM = jhIsObject(nextSnapshot.maintenance) ? nextSnapshot.maintenance : {}
    if (!prevM.quietingDown && nextM.quietingDown) {
      events.push({
        type: "maintenance",
        severity: "info",
        message: "Jenkins is preparing to shut down (quiet-down active)"
      })
    } else if (prevM.quietingDown && !nextM.quietingDown) {
      events.push({ type: "maintenance", severity: "info", message: "Jenkins quiet-down cancelled" })
    }
    if (!prevM.restartRequired && nextM.restartRequired) {
      events.push({
        type: "maintenance",
        severity: "info",
        message: "Restart required to complete plugin updates"
      })
    }
    var prevU = jhNum(prevM.updatesAvailable, 0)
    var nextU = jhNum(nextM.updatesAvailable, 0)
    if (nextU > prevU && nextU > 0) {
      events.push({
        type: "maintenance",
        severity: "info",
        message: nextU + (nextU === 1 ? " plugin update available" : " plugin updates available")
      })
    }
  }

  return events
}

// -------------------------------------------------------- command builders

// netrc content so curl authenticates without the token ever appearing in
// a process argument list (visible via ps).
function buildNetrc(user, token, jenkinsUrl) {
  return "machine " + jhHostOf(jenkinsUrl)
    + "\nlogin " + (user === undefined || user === null ? "" : String(user))
    + "\npassword " + (token === undefined || token === null ? "" : String(token))
}

function buildCurlArgs(endpoint, method, jenkinsUrl, netrcPath, crumb) {
  var args = ["curl", "-fsS", "--max-time", "8", "--netrc-file", netrcPath, "-H", "Accept: application/json"]
  if (method && method !== "GET") {
    args.push("-X", method)
  }
  if (crumb) {
    args.push("-H", "Jenkins-Crumb: " + crumb)
  }
  args.push(jhJoinUrl(jenkinsUrl, endpoint))
  return args
}

// Safe actions: quietDown / cancelQuietDown / cancelQueueItem /
// nodeOffline / nodeOnline. `action` is either a descriptor object
// {action, targetId} or a plain string (with targetId as second argument).
function buildActionCommand(action, targetId, jenkinsUrl, netrcPath, crumb) {
  var act = jhIsObject(action) ? action : { action: String(action || ""), targetId: targetId }
  var kind = String(act.action || "")
  var id = act.targetId !== undefined && act.targetId !== null ? act.targetId : targetId
  var endpoint = ""

  if (kind === "cancelQueueItem") {
    endpoint = "/queue/cancelItem?id=" + encodeURIComponent(id)
  } else if (kind === "quietDown") {
    endpoint = "/quietDown"
  } else if (kind === "cancelQuietDown") {
    endpoint = "/cancelQuietDown"
  } else if (kind === "nodeOffline") {
    endpoint = "/computer/" + encodeURIComponent(id) + "/doChangeOffline?offline=true&offlineMessage=jenkins-health"
  } else if (kind === "nodeOnline") {
    endpoint = "/computer/" + encodeURIComponent(id) + "/doChangeOffline?offline=false"
  } else {
    return []
  }

  return buildCurlArgs(endpoint, "POST", jenkinsUrl, netrcPath, crumb)
}

// Node (test harness) export. In QML, `module` is undefined and this whole
// block is skipped — the functions above are the import surface.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    parseController: parseController,
    parseNodes: parseNodes,
    parseQueue: parseQueue,
    parsePlugins: parsePlugins,
    parseUpdateCenter: parseUpdateCenter,
    assess: assess,
    diffEvents: diffEvents,
    buildNetrc: buildNetrc,
    buildCurlArgs: buildCurlArgs,
    buildActionCommand: buildActionCommand
  }
}
