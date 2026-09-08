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


// Recursive job collector for nested folder listings (see parseController).
// Leaves carry the extended per-job data from the tree query: Jenkins'
// own healthReport score, the last build (number/result/duration/time)
// and the last successful build (null = the job has never gone green).
// Every extended field degrades to null when absent, so flat/legacy
// listings parse identically to the shape the fixtures froze.
function jhCollectJobs(rawJobs, prefix, out) {
  for (var i = 0; i < rawJobs.length; i++) {
    var j = rawJobs[i]
    if (!jhIsObject(j)) continue
    var name = jhStr(j.name, "")
    var full = prefix ? prefix + "/" + name : name
    if (Array.isArray(j.jobs)) {
      jhCollectJobs(j.jobs, full, out)
    } else {
      var hr = Array.isArray(j.healthReport) && jhIsObject(j.healthReport[0])
        ? j.healthReport[0] : null
      out.push({
        name: full,
        color: jhStr(j.color, ""),
        health: hr ? jhNum(hr.score, null) : null,
        healthDesc: hr ? jhStr(hr.description, "") : "",
        lastBuild: jhIsObject(j.lastBuild) ? {
          number: jhNum(j.lastBuild.number, 0),
          timestamp: jhNum(j.lastBuild.timestamp, 0),
          duration: jhNum(j.lastBuild.duration, 0),
          result: jhStr(j.lastBuild.result, ""),
          building: !!j.lastBuild.building
        } : null,
        lastSuccess: jhIsObject(j.lastSuccessfulBuild) ? {
          number: jhNum(j.lastSuccessfulBuild.number, 0),
          timestamp: jhNum(j.lastSuccessfulBuild.timestamp, 0),
          duration: jhNum(j.lastSuccessfulBuild.duration, 0)
        } : null
      })
    }
  }
}

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
  // Collect jobs from a (possibly nested) Jenkins listing. The tree query
  // returns folders with a `jobs` array (empty or populated); runnable jobs
  // carry a `color`. Folder names prefix their children ("Folder/Job") so
  // failure events stay unambiguous when the same job name exists in
  // several folders. Flat listings (no `jobs` attr) pass through identity.
  var jobs = []
  var rawJobs = Array.isArray(apiJson.jobs) ? apiJson.jobs : []
  jhCollectJobs(rawJobs, "", jobs)

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

    // One-off executors are transient (flyweight/pipeline steps) and are
    // never part of the executor total, but they do hold workspace
    // leases — so they count toward busy separately. A node can read
    // idle on the regular executors while a one-off still works.
    var executors = Array.isArray(c.executors) ? c.executors : []
    var busy = 0
    for (var e = 0; e < executors.length; e++) {
      if (jhIsObject(executors[e]) && executors[e].idle === false) busy++
    }
    var oneOff = Array.isArray(c.oneOffExecutors) ? c.oneOffExecutors : []

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
      executorsIdle: executors.length - busy,
      oneOffBusy: oneOff.length
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
//   offline node 8   slow node 4   disk-critical 10 (offline deaths keep
//   it — a node dying with a full disk is not a refund)   backlog 8
//   stuck item 4     red job 6     unstable>=2 4          updates 2
//   restart required 2
// Levels: score >= 95 "ok", >= 50 "warn", else "critical" — except that
// a third or more of the agents offline forces "critical" regardless of
// score (fleet-capacity floor).
function assess(controller, nodes, queue, plugins, updateCenter, config, now) {
  var cfg = jhIsObject(config) ? config : {}
  var queueThreshold = jhNum(cfg.queueBacklogThreshold, 10)
  var diskWarnGb = jhNum(cfg.diskWarnGb, 25)
  var diskCriticalGb = jhNum(cfg.diskCriticalGb, 10)
  // Percentage thresholds scale the floors with the volume: effective
  // = max(absolute, pct × total). Totals exist only on probed nodes
  // (the monitor API reports none), so monitor-only nodes keep the
  // absolute thresholds. Defaults 10/3: a 460 GB agent warns at 46 GB
  // and goes critical at 14 GB — hours before fixed 25/10 floors notice
  // on big volumes, while small volumes never over-warn.
  var diskWarnPct = jhNum(cfg.diskWarnPct, 10)
  var diskCriticalPct = jhNum(cfg.diskCriticalPct, 3)
  var rttWarnMs = jhNum(cfg.responseTimeWarnMs, 1000)
  // Failures penalty cap (0 = uncapped). Controllers with a large job
  // catalog can carry a habitual red minority (e.g. 41 of 774 = 5%); the
  // linear 6×red penalty floors the score at 0 and red becomes the
 // permanent baseline, hiding real regressions. A cap keeps the signal.
  var failCap = jhNum(cfg.failurePenaltyCap, 0)
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
        failingNames: [], unstableNames: [], buildingNames: [],
        jobs: [], neverGreen: 0, degrading: 0, built24h: 0,
        recent: [], rollups: []
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
  // --- job depth (extended fields; all null-safe on flat listings)
  var neverGreen = 0
  var degrading = 0
  var built24h = 0
  var nowMs = jhNum(now, 0)
  var dayAgoMs = nowMs - 86400000
  for (var d = 0; d < jobs.length; d++) {
    var dj = jobs[d]
    if (isNeverGreen(dj)) neverGreen++
    if (isDegrading(dj)) degrading++
    if (jhIsObject(dj.lastBuild) && dj.lastBuild.timestamp >= dayAgoMs
      && dj.lastBuild.timestamp <= nowMs) {
      built24h++
    }
  }

  // --- node assessment
  var nodeOut = []
  var overallReasons = []
  var offlineNodes = 0
  var diskCriticalCount = 0
  var slowNodes = 0
  var score = 100

  // Tier of one volume against its effective thresholds.
  function tierOf(gb, warnGb, critGb) {
    return gb < critGb ? "critical" : gb < warnGb ? "low" : "ok"
  }

  for (var n = 0; n < parsedNodes.nodes.length; n++) {
    var node = parsedNodes.nodes[n]
    var isOffline = !!node.offline || !!node.temporarilyOffline
    var diskGb = node.diskBytes !== null && node.diskBytes !== undefined
      ? node.diskBytes / 1e9 : null
    var tmpGb = node.tempBytes !== null && node.tempBytes !== undefined
      ? node.tempBytes / 1e9 : null
    // /tmp is a separate volume on most agents and is the one that
    // actually fills (workspace cleanup never touches it), so the disk
    // tier keys on the worse of the two reported volumes.
    var minGb = null
    if (diskGb !== null && tmpGb !== null) minGb = diskGb < tmpGb ? diskGb : tmpGb
    else if (diskGb !== null) minGb = diskGb
    else if (tmpGb !== null) minGb = tmpGb
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
    // Effective per-volume thresholds: scale with the volume when the
    // probe supplied its total, otherwise the absolute floors.
    var rootTotalGb = typeof node.rootTotalBytes === "number" && node.rootTotalBytes > 0
      ? node.rootTotalBytes / 1e9 : null
    var tmpTotalGb = typeof node.tmpTotalBytes === "number" && node.tmpTotalBytes > 0
      ? node.tmpTotalBytes / 1e9 : null
    var rootWarnGb = rootTotalGb !== null
      ? Math.max(diskWarnGb, diskWarnPct / 100 * rootTotalGb) : diskWarnGb
    var rootCritGb = rootTotalGb !== null
      ? Math.max(diskCriticalGb, diskCriticalPct / 100 * rootTotalGb) : diskCriticalGb
    var tmpWarnGb = tmpTotalGb !== null
      ? Math.max(diskWarnGb, diskWarnPct / 100 * tmpTotalGb) : diskWarnGb
    var tmpCritGb = tmpTotalGb !== null
      ? Math.max(diskCriticalGb, diskCriticalPct / 100 * tmpTotalGb) : diskCriticalGb
    var rootTier = diskGb !== null ? tierOf(diskGb, rootWarnGb, rootCritGb) : null
    var tmpTier = tmpGb !== null ? tierOf(tmpGb, tmpWarnGb, tmpCritGb) : null
    var worstTier = null
    if (rootTier === "critical" || tmpTier === "critical") worstTier = "critical"
    else if (rootTier === "low" || tmpTier === "low") worstTier = "low"
    else if (rootTier !== null || tmpTier !== null) worstTier = "ok"
    if (worstTier === "critical") {
      reasons.push("disk space critical: " + jhGbLabel(minGb) + " free")
      level = "critical"
      // Offline deaths KEEP the penalty: a node that went offline with a
      // critical disk died OF that disk — trading the -10 for the cheaper
      // -8 offline penalty refunded two points at the worst moment of the
      // incident that motivated this (measured: 90 online vs 92 offline
      // for the same 2.3 GB).
      diskCriticalCount++
      overallReasons.push("node " + node.displayName + " disk space critical: " + jhGbLabel(minGb) + " free")
    } else if (worstTier === "low") {
      reasons.push("disk space low: " + jhGbLabel(minGb) + " free")
      if (level === "ok") level = "warn"
      overallReasons.push("node " + node.displayName + " disk space low: " + jhGbLabel(minGb) + " free")
    }

    // Dedicated disk tier for edge-triggered notifications: never derived
    // from `level`, which also folds offline/slow causes. An online node
    // whose monitors report no values is "unknown" — that is exactly the
    // state a filling disk hides behind, so it flags the node at warn
    // level with a listed reason (attention without a numeric penalty:
    // the evidence is weak and the Service toast is debounced). Offline
    // nodes keep whatever the (stale) values say, but diffEvents never
    // diffs them, so no flapping.
    var diskTier = worstTier
    if (diskTier === null && !isOffline) {
      diskTier = "unknown"
      reasons.push("disk state unknown (monitors not reporting)")
      if (level === "ok") level = "warn"
      overallReasons.push("node " + node.displayName + " disk state unknown (monitors not reporting)")
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
      tmpGb: tmpGb,
      diskTier: diskTier,
      probedAt: typeof node.probedAt === "number" ? node.probedAt : null,
      rootFreeBytes: typeof node.rootFreeBytes === "number" ? node.rootFreeBytes : null,
      tmpFreeBytes: typeof node.tmpFreeBytes === "number" ? node.tmpFreeBytes : null,
      rootTotalBytes: typeof node.rootTotalBytes === "number" ? node.rootTotalBytes : null,
      tmpTotalBytes: typeof node.tmpTotalBytes === "number" ? node.tmpTotalBytes : null,
      responseTimeMs: node.responseTimeMs,
      executorsTotal: node.executorsTotal,
      executorsIdle: node.executorsIdle,
      oneOffBusy: node.oneOffBusy,
      utilization: node.executorsTotal > 0
        ? (node.executorsTotal - node.executorsIdle) / node.executorsTotal : 0,
      level: level,
      reasons: reasons
    })
  }

  if (offlineNodes > 0) score -= 8 * offlineNodes
  if (diskCriticalCount > 0) score -= 10 * diskCriticalCount
  if (slowNodes > 0) score -= 4 * slowNodes

  // Fleet-capacity floor: with a third or more of the agents offline the
  // chip goes critical regardless of score. The score band would read
  // warn at 66 with three of eight agents down — a fleet that lost a
  // third of its executor pools is an incident even when the survivors
  // are pristine. The floor can only worsen the band, never improve it.
  var totalNodes = parsedNodes.nodes.length
  var offlineFrac = totalNodes > 0 ? offlineNodes / totalNodes : 0
  if (offlineNodes > 0 && offlineFrac >= 1 / 3) {
    overallReasons.push(offlineNodes + " of " + totalNodes
      + " agents offline (a third or more) — fleet capacity critical")
  }

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
    var failPenalty = 6 * redCount
    if (failCap > 0 && failPenalty > failCap) {
      failPenalty = failCap
      // The reason keeps the true count; the score only is capped.
    }
    score -= failPenalty
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
      buildingNames: buildingNames,
      jobs: jobs,
      neverGreen: neverGreen,
      degrading: degrading,
      built24h: built24h,
      recent: recentBuilds(jobs, 20),
      rollups: folderRollups(jobs)
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
      level: (offlineFrac >= 1 / 3)
        ? "critical"
        : score >= 95 ? "ok" : score >= 50 ? "warn" : "critical",
      score: score,
      reasons: overallReasons
    }
  }
}

// ------------------------------------------------------------ event diffing

// Edge-triggered notification events between two assess() snapshots.
// Event types: controller-down, controller-up, node-offline, node-online,
// node-disk-low, node-disk-critical, node-disk-ok,
// job-failure, job-recovered, queue-backlog, queue-clear, maintenance.
// (node-disk-unknown is synthesized by Service after a debounce, not
// diffed here — see the disk-tier block below for why.)
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

  // node state and disk-tier changes (matched by displayName, both
  // snapshots reachable)
  if (notifyNodes && prevUp && nextUp) {
    var prevMap = {}
    var prevNodes = Array.isArray(prevSnapshot.nodes) ? prevSnapshot.nodes : []
    for (var i = 0; i < prevNodes.length; i++) {
      prevMap[prevNodes[i].displayName] = prevNodes[i]
    }
    var nextMap = {}
    var nextNodes = Array.isArray(nextSnapshot.nodes) ? nextSnapshot.nodes : []
    for (var j = 0; j < nextNodes.length; j++) {
      nextMap[nextNodes[j].displayName] = nextNodes[j]
    }
    for (var name in prevMap) {
      var prevNode = prevMap[name]
      var nextNode = nextMap[name]
      var nextState = nextNode ? nextNode.state : undefined
      if (prevNode.state === "online" && nextState === "offline") {
        var cause = nextNode.reasons && nextNode.reasons.length > 0
          ? " (" + nextNode.reasons.join("; ") + ")" : ""
        events.push({
          type: "node-offline",
          severity: "warn",
          message: "Node " + name + " went offline" + cause
        })
      } else if (prevNode.state === "offline" && nextState === "online") {
        events.push({
          type: "node-online",
          severity: "info",
          message: "Node " + name + " is back online"
        })
      }

      // Disk-tier edges, only while the node is online in the NEXT
      // snapshot: an offline node's monitor values are frozen (stale),
      // so diffing across the offline boundary would flap. Transitions
      // INTO low/critical warn; back to "ok" from low/critical recovers.
      // The "unknown" tier (online, monitors null) is deliberately NOT
      // diffed here: monitors report null for a poll or two after every
      // agent reconnect, so an edge here would toast on each reconnect.
      // Service debounces it across consecutive polls instead.
      if (nextState === "online" && nextNode && nextNode.diskTier
          && nextNode.diskTier !== (prevNode && prevNode.diskTier)) {
        if (nextNode.diskTier === "critical") {
          events.push({
            type: "node-disk-critical",
            severity: "critical",
            message: "Node " + name + " disk space critical: "
              + jhGbLabel(Math.min(
                  nextNode.diskGb !== null && nextNode.diskGb !== undefined ? nextNode.diskGb : Infinity,
                  nextNode.tmpGb !== null && nextNode.tmpGb !== undefined ? nextNode.tmpGb : Infinity))
              + " free"
          })
        } else if (nextNode.diskTier === "low") {
          events.push({
            type: "node-disk-low",
            severity: "warn",
            message: "Node " + name + " disk space low: "
              + jhGbLabel(Math.min(
                  nextNode.diskGb !== null && nextNode.diskGb !== undefined ? nextNode.diskGb : Infinity,
                  nextNode.tmpGb !== null && nextNode.tmpGb !== undefined ? nextNode.tmpGb : Infinity))
              + " free"
          })
        } else if (prevNode && (prevNode.diskTier === "low"
            || prevNode.diskTier === "critical")) {
          events.push({
            type: "node-disk-ok",
            severity: "info",
            message: "Node " + name + " disk space recovered"
          })
        }
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

// ------------------------------------------------------------- job depth
// Views over the enriched leaf records (see jhCollectJobs). All pure and
// null-safe: a listing without the extended fields yields empty views.

function jobFolder(name) {
  var s = String(name || "")
  var slash = s.indexOf("/")
  return slash === -1 ? "" : s.substring(0, slash)
}

// "Never green": the job has run at least once and has no successful
// build on record — the strongest broken-vs-flaky signal the tree
// query exposes without per-job build requests.
function isNeverGreen(job) {
  return !!job
    && job.lastBuild !== null && job.lastBuild !== undefined
    && (job.lastSuccess === null || job.lastSuccess === undefined)
}

// Ball still blue but the health report is degraded — failing builds
// hiding behind a last-success color.
function isDegrading(job) {
  return !!job
    && job.health !== null && job.health !== undefined && job.health < 100
    && (job.color === "blue" || job.color === "blue_anime")
}

// Most recent builds across the catalog, newest first. One build per
// job (the tree query returns lastBuild only) — an honest "last
// builds" feed, not a full build log.
function recentBuilds(jobs, limit) {
  var src = Array.isArray(jobs) ? jobs : []
  var lim = jhNum(limit, 20)
  var withBuilds = []
  for (var i = 0; i < src.length; i++) {
    if (jhIsObject(src[i]) && jhIsObject(src[i].lastBuild)) withBuilds.push(src[i])
  }
  withBuilds.sort(function (a, b) {
    return b.lastBuild.timestamp - a.lastBuild.timestamp
  })
  var out = []
  for (var k = 0; k < withBuilds.length && out.length < lim; k++) {
    var jb = withBuilds[k].lastBuild
    out.push({
      name: jhStr(withBuilds[k].name, ""),
      building: !!jb.building,
      result: jhStr(jb.result, ""),
      number: jhNum(jb.number, 0),
      durationMs: jhNum(jb.duration, 0),
      timestamp: jhNum(jb.timestamp, 0)
    })
  }
  return out
}

// Per-top-level-folder rollups for the Overview tab, worst first
// (most failing, then lowest health). Flat listings roll up under "".
function folderRollups(jobs) {
  var src = Array.isArray(jobs) ? jobs : []
  var byFolder = {}
  var order = []
  for (var i = 0; i < src.length; i++) {
    var j = src[i]
    if (!jhIsObject(j)) continue
    var f = jobFolder(j.name)
    if (!jhIsObject(byFolder[f])) {
      byFolder[f] = { folder: f, total: 0, failing: 0, neverGreen: 0, worstHealth: null }
      order.push(f)
    }
    var r = byFolder[f]
    r.total++
    var c = jhStr(j.color, "")
    if (c === "red" || c === "red_anime") r.failing++
    if (isNeverGreen(j)) r.neverGreen++
    if (j.health !== null && j.health !== undefined
      && (r.worstHealth === null || j.health < r.worstHealth)) {
      r.worstHealth = j.health
    }
  }
  var out = []
  for (var k = 0; k < order.length; k++) out.push(byFolder[order[k]])
  out.sort(function (a, b) {
    if (b.failing !== a.failing) return b.failing - a.failing
    var ha = a.worstHealth === null ? 101 : a.worstHealth
    var hb = b.worstHealth === null ? 101 : b.worstHealth
    return ha - hb
  })
  return out
}

// ---------------------------------------------------------------- history
// Time series kept by the service (persisted across restarts): one point
// per successful poll plus per-node disk readings. Compaction is pure
// and bucketed: raw points inside the last hour, 5-minute buckets for
// points (15 for disk) up to 24h, older points dropped. Sparklines read
// the compacted series through fixed slot windows.

function historyAppendPt(pts, tSec, score, queueDepth) {
  var next = (Array.isArray(pts) ? pts : []).slice()
  next.push({ t: jhNum(tSec, 0), s: jhNum(score, 0), q: jhNum(queueDepth, 0) })
  return next
}

function historyCompactPts(pts, nowSec) {
  var src = Array.isArray(pts) ? pts : []
  var now = jhNum(nowSec, 0)
  var hourAgo = now - 3600
  var dayAgo = now - 86400
  var out = []
  for (var i = 0; i < src.length; i++) {
    var p = src[i]
    if (!jhIsObject(p) || typeof p.t !== "number" || p.t < dayAgo) continue
    if (p.t >= hourAgo) {
      out.push(p)
      continue
    }
    // Points arrive oldest-first: same 5-minute bucket replaces the
    // previous sample so each bucket keeps its newest reading.
    var b = Math.floor(p.t / 300)
    var last = out.length > 0 ? out[out.length - 1] : null
    if (last && Math.floor(last.t / 300) === b) out[out.length - 1] = p
    else out.push(p)
  }
  return out
}

function historyAppendDisk(disks, name, tSec, gb) {
  var src = jhIsObject(disks) ? disks : {}
  var key = jhStr(name, "")
  if (!key || gb === null || gb === undefined) return src
  var next = {}
  for (var k in src) next[k] = src[k]
  next[key] = (Array.isArray(src[key]) ? src[key] : [])
    .concat([{ t: jhNum(tSec, 0), v: jhNum(gb, 0) }])
  return next
}

function historyCompactDisk(series, nowSec) {
  var src = Array.isArray(series) ? series : []
  var dayAgo = jhNum(nowSec, 0) - 86400
  var out = []
  for (var i = 0; i < src.length; i++) {
    var p = src[i]
    if (!jhIsObject(p) || typeof p.t !== "number" || p.t < dayAgo) continue
    var b = Math.floor(p.t / 900)
    var last = out.length > 0 ? out[out.length - 1] : null
    if (last && Math.floor(last.t / 900) === b) out[out.length - 1] = p
    else out.push(p)
  }
  return out
}

function historyCompactDisks(disks, nowSec) {
  var src = jhIsObject(disks) ? disks : {}
  var out = {}
  for (var k in src) out[k] = historyCompactDisk(src[k], nowSec)
  return out
}

// Project a {t, field} series onto the {t, v} shape sparklineSlots reads.
function historySeries(pts, field) {
  var src = Array.isArray(pts) ? pts : []
  var out = []
  for (var i = 0; i < src.length; i++) {
    if (!jhIsObject(src[i])) continue
    out.push({ t: src[i].t, v: jhNum(src[i][field], null) })
  }
  return out
}

// Fixed slot window over a {t, v} series: each slot keeps the newest
// value that fell inside it; slots without data stay null.
function sparklineSlots(series, nowSec, windowSec, slots) {
  var src = Array.isArray(series) ? series : []
  var n = Math.max(1, jhNum(slots, 24))
  var now = jhNum(nowSec, 0)
  var start = now - Math.max(1, jhNum(windowSec, 86400))
  var step = (now - start) / n
  var out = new Array(n)
  for (var w = 0; w < n; w++) out[w] = null
  for (var i = 0; i < src.length; i++) {
    var p = src[i]
    if (!jhIsObject(p) || typeof p.t !== "number" || typeof p.v !== "number") continue
    if (p.t < start || p.t > now) continue
    var idx = Math.floor((p.t - start) / step)
    if (idx > n - 1) idx = n - 1
    out[idx] = p.v
  }
  return out
}

// -------------------------------------------------------- command builders

// netrc content so curl authenticates without the token ever appearing in
// a process argument list (visible via ps).
function buildNetrc(user, token, jenkinsUrl) {
  return "machine " + jhHostOf(jenkinsUrl)
    + "\nlogin " + (user === undefined || user === null ? "" : String(user))
    + "\npassword " + (token === undefined || token === null ? "" : String(token))
}

function buildCurlArgs(endpoint, method, jenkinsUrl, netrcPath, crumb, timeoutSec) {
  // timeoutSec defaults to 8 for the light endpoints; the catalog tree
  // query needs far more (a cold Jenkins cache on a large controller
  // measured 34s for the deep jobs tree, 2.7s warm — an 8s budget there
  // turns a cold cache into a permanent "controller unreachable", since
  // the timing-out poll never warms the cache it is waiting for).
  var args = ["curl", "-fsS", "--max-time", String(jhNum(timeoutSec, 8)),
    "--netrc-file", netrcPath, "-H", "Accept: application/json"]
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
// {action, targetId} or a plain string (with targetId as second
// argument). A root /doWorkspaceCleanup POST was tried and removed:
// the route does not exist on the target controller (GET → 404 while
// quietDown GET → 405), so the script-console path below is the only
// workspace-cleanup mechanism this plugin ships.
//
// nodeWorkspaceList / nodeWorkspaceClean run fixed Groovy templates on
// the script console (requires an admin-scoped token): the node NAME is
// the only value ever interpolated into the script text. Both walk the
// workspace tree RECURSIVELY so folder-nested jobs appear as their full
// relative paths (a folder job's workspace dir is a directory of leaf
// workspaces, and the old top-level-only walk showed four folders where
// ~25 job workspaces lived). The clean script skips a leaf when its job
// — resolved by the folder-qualified name, with @2 duplicates mapped to
// their base job — is building ANYWHERE, so one busy executor never
// blocks reclaiming an idle job's workspace; the residual race (a job
// starting between check and delete) is the standard Jenkins wipe race
// and recovers as a clean checkout.
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
  } else if (kind === "nodeOffline" || kind === "nodeOnline") {
    // doChangeOffline is gone from current Jenkins (404 on 2.568.2 —
    // both panel toggles silently did nothing), and the surviving
    // toggleOffline is a STATE FLIP: POSTing it blind on a node that
    // recovered on its own takes it back down (verified the hard way).
    // So this command is a state READ; the Service parses it and only
    // POSTs the toggle when the node is not already in the wanted state
    // — a second click on a satisfied state is a no-op.
    return buildCurlArgs("/computer/" + encodeURIComponent(id)
      + "/api/json?tree=offline%2CtemporarilyOffline", "GET", jenkinsUrl, netrcPath, null)
  } else if (kind === "nodeDiskProbe") {
    return buildScriptCommand(diskProbeScript(id), jenkinsUrl, netrcPath, crumb)
  } else if (kind === "nodeWorkspaceList" || kind === "nodeWorkspaceClean") {
    var script = kind === "nodeWorkspaceList"
      ? workspaceListScript(id) : workspaceCleanScript(id)
    return buildScriptCommand(script, jenkinsUrl, netrcPath, crumb)
  } else {
    return []
  }

  return buildCurlArgs(endpoint, "POST", jenkinsUrl, netrcPath, crumb)
}

// Groovy single-quoted string literal: the node name is the only
// interpolated value, escaped so nothing else can ride along.
function jhGroovyString(value) {
  return "'" + String(value === undefined || value === null ? "" : value)
    .replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'"
}

function workspaceListScript(nodeName) {
  return [
    "def c = Jenkins.instance.getComputer(" + jhGroovyString(nodeName) + ")",
    // getComputer matches the config NAME only; the built-in node's
    // name is "" and its display name is "Built-In Node" — resolve by
    // display name when the name lookup missed.
    "if (c == null) { c = Jenkins.instance.computers.toList().find { it.displayName == " + jhGroovyString(nodeName) + " } }",
    "if (c == null) { println('NO_SUCH_COMPUTER'); return }",
    "def ws = c.node != null ? c.node.rootPath : null",
    "if (ws != null) { ws = ws.child('workspace') }",
    "if (ws == null) { println('NO_WORKSPACE_ROOT'); return }",
    // Recursive walk: folder jobs' workspaces are directories of leaf
    // job workspaces, so a directory whose relative path resolves to a
    // non-Job item (a folder) is descended into; everything else is a
    // leaf (a job workspace or an orphan from a deleted job). @2
    // duplicates resolve to null and are listed as the leaves they are.
    "def n = 0",
    "def walk",
    "walk = { d, prefix ->",
    "  d.list().findAll { it.isDirectory() }.each { e ->",
    "    def rel = prefix.isEmpty() ? e.name : prefix + '/' + e.name",
    "    def item = null",
    "    try { item = Jenkins.instance.getItemByFullName(rel) } catch (x) { item = null }",
    "    if (item != null && !(item instanceof hudson.model.Job)) {",
    "      walk(e, rel)",
    "    } else {",
    "      println('DIR ' + rel); n++",
    "    }",
    "  }",
    "}",
    "try { walk(ws, '') } catch (err) { println('WALK_FAILED ' + err.message) }",
    "println('LISTED ' + n)"
  ].join("\n")
}

function workspaceCleanScript(nodeName) {
  return [
    "def c = Jenkins.instance.getComputer(" + jhGroovyString(nodeName) + ")",
    "if (c == null) { c = Jenkins.instance.computers.toList().find { it.displayName == " + jhGroovyString(nodeName) + " } }",
    "if (c == null) { println('NO_SUCH_COMPUTER'); return }",
    "def ws = c.node != null ? c.node.rootPath : null",
    "if (ws != null) { ws = ws.child('workspace') }",
    "if (ws == null) { println('NO_WORKSPACE_ROOT'); return }",
    // No whole-node gates: a monitor-disconnected agent keeps its channel
    // (that is exactly when cleanup is needed), and a hard-dead channel
    // fails the walk visibly. Per-job building checks below carry the
    // safety instead of a coarse node-idle gate.
    "def deleted = 0; def skipped = 0; def errors = 0",
    // A leaf is skipped when its job is building anywhere — resolved by
    // the folder-qualified relative path; an @2 duplicate maps to its
    // base job, which is the copy a concurrent build would reuse.
    "def isBuilding = { rel ->",
    "  def base = rel.endsWith('@2') ? rel.substring(0, rel.length() - 2) : rel",
    "  try {",
    "    def item = Jenkins.instance.getItemByFullName(base)",
    "    return item != null && item.isBuilding()",
    "  } catch (x) { return false }",
    "}",
    "def walk",
    "walk = { d, prefix ->",
    "  d.list().findAll { it.isDirectory() }.each { e ->",
    "    def rel = prefix.isEmpty() ? e.name : prefix + '/' + e.name",
    "    def item = null",
    "    try { item = Jenkins.instance.getItemByFullName(rel) } catch (x) { item = null }",
    "    if (item != null && !(item instanceof hudson.model.Job)) {",
    "      walk(e, rel)",
    "    } else if (isBuilding(rel)) {",
    "      skipped++",
    "    } else {",
    "      try { e.deleteRecursive(); deleted++ } catch (err) { errors++ }",
    "    }",
    "  }",
    "}",
    "try { walk(ws, '') } catch (err) { println('WALK_FAILED ' + err.message) }",
    "println('RESULT deleted=' + deleted + ' skipped=' + skipped + ' errors=' + errors)"
  ].join("\n")
}

// ---- live disk probe (opt-in) ------------------------------------------
// Jenkins's DiskSpaceMonitor samples lazily (it refreshes on node activity,
// not a wall clock), so a filling volume can sit far below the thresholds
// while the monitor still reports an old number — a probe of a real
// controller found 0 GB usable where the monitor said 28 GB. The probe
// asks the node itself, over the same controller /scriptText endpoint the
// workspace scripts use: the script below resolves the Computer, then
// runs one script ON THE NODE'S CHANNEL (RemotingDiagnostics — the same
// primitive /computer/<node>/scriptText is built on) reading
// File.usableSpace for the workspace root and the agent JVM's tmpdir.
// usableSpace is the gate, not freeSpace: on a disk with a root reserve,
// freeSpace counts bytes a build process cannot write.
var PROBE_FRESH_MS = 15 * 60 * 1000

function diskProbeScript(nodeName) {
  return [
    "def c = Jenkins.instance.getComputer(" + jhGroovyString(nodeName) + ")",
    "if (c == null) { c = Jenkins.instance.computers.toList().find { it.displayName == " + jhGroovyString(nodeName) + " } }",
    "if (c == null) { println('NO_SUCH_COMPUTER'); return }",
    "if (!c.online) { println('NODE_OFFLINE'); return }",
    "def root = c.node != null ? c.node.rootPath : null",
    "if (root == null) { println('NO_WORKSPACE_ROOT'); return }",
    // The channel script rides a double-quoted Groovy literal: the root
    // path is interpolated through inspect() (a valid, escaped literal —
    // the only value that is not fixed text besides the node name, which
    // is escaped by jhGroovyString). The exchange is KEYED (name=value
    // pairs, extracted by regex below) so a prefix like RemotingDiagnostics'
    // "Result:" or stray output can never misalign the fields.
    "def probe = \"def r = new File(${root.getRemote().inspect()}); def t = new File(System.getProperty('java.io.tmpdir')); 'rootUsable=' + r.usableSpace + ' rootFree=' + r.freeSpace + ' rootTotal=' + r.totalSpace + ' tmpUsable=' + t.usableSpace + ' tmpFree=' + t.freeSpace + ' tmpTotal=' + t.totalSpace\"",
    "def res = c.channel != null ? hudson.util.RemotingDiagnostics.executeGroovy(probe.toString(), c.channel) : null",
    // Built-in node without a channel: its root IS controller-local.
    "if (res == null) {",
    "  def r0 = new File(root.getRemote())",
    "  def t0 = new File(System.getProperty('java.io.tmpdir'))",
    "  res = 'rootUsable=' + r0.usableSpace + ' rootFree=' + r0.freeSpace + ' rootTotal=' + r0.totalSpace + ' tmpUsable=' + t0.usableSpace + ' tmpFree=' + t0.freeSpace + ' tmpTotal=' + t0.totalSpace",
    "}",
    "def m = res =~ /rootUsable=(\\d+) rootFree=(\\d+) rootTotal=(\\d+) tmpUsable=(\\d+) tmpFree=(\\d+) tmpTotal=(\\d+)/",
    "if (m.find()) { println('PROBE ' + m.group(0)) } else { println('NO_PROBE_RESULT') }"
  ].join("\n")
}

// PROBE answers one line with four byte counts. Verdict lines mean "not
// ok" without being errors; a 403-class body parses to the admin-token
// message, exactly like the workspace actions.
function parseDiskProbe(exitCode, body) {
  var text = String(body || "")
  if (exitCode !== 0) {
    var denied = /administer|script console|RunScripts|403/i.test(text)
    return { ok: false, denied: denied,
      error: denied ? "no script-console permission — the token must be admin-scoped"
        : "probe failed (exit " + exitCode + ")" }
  }
  var m = text.match(/PROBE rootUsable=(\d+) rootFree=(\d+) rootTotal=(\d+) tmpUsable=(\d+) tmpFree=(\d+) tmpTotal=(\d+)/)
  if (!m) {
    var verdicts = ["NO_SUCH_COMPUTER", "NODE_OFFLINE", "NO_WORKSPACE_ROOT", "NO_PROBE_RESULT"]
    var found = ""
    for (var i = 0; i < verdicts.length; i++) {
      if (text.indexOf(verdicts[i]) !== -1) { found = verdicts[i]; break }
    }
    return { ok: false, denied: false,
      error: found ? found : "probe failed (unexpected response)" }
  }
  return {
    ok: true, denied: false,
    rootUsable: parseInt(m[1], 10),
    rootFree: parseInt(m[2], 10),
    rootTotal: parseInt(m[3], 10),
    tmpUsable: parseInt(m[4], 10),
    tmpFree: parseInt(m[5], 10),
    tmpTotal: parseInt(m[6], 10)
  }
}

// Merge live probe values into a parseNodes result before assess(): a
// fresh probe for an ONLINE node replaces the lazily-sampled monitor
// numbers, and every downstream behavior (disk tier, score, edges,
// toasts) then runs on measured disk with no new event types. Freshness
// is deliberately generous: a transient probe failure must not bounce
// the tier back to a stale monitor reading, or the disk edges would
// flap. Offline nodes keep their frozen monitor values (the existing
// no-flap convention). The names that actually merged ride back as
// probedNames so the Service can re-baseline (prevSnapshot = null) when
// an online node LOSES coverage: reverting to the stale monitor value
// must never diff into a false "disk recovered" event.
function mergeProbeData(nodesParsed, probeData, nowMs, freshMs) {
  if (!jhIsObject(nodesParsed) || !Array.isArray(nodesParsed.nodes)) return nodesParsed
  var merged = []
  if (jhIsObject(probeData)) {
    var horizon = typeof freshMs === "number" ? freshMs : PROBE_FRESH_MS
    for (var i = 0; i < nodesParsed.nodes.length; i++) {
      var node = nodesParsed.nodes[i]
      var p = probeData[node.displayName]
      if (!jhIsObject(p)) continue
      if (node.offline || node.temporarilyOffline) continue
      var probedAt = typeof p.probedAt === "number" ? p.probedAt : 0
      if (nowMs - probedAt > horizon) continue
      if (typeof p.diskBytes === "number") node.diskBytes = p.diskBytes
      if (typeof p.tempBytes === "number") node.tempBytes = p.tempBytes
      node.probedAt = probedAt
      node.rootFreeBytes = typeof p.rootFreeBytes === "number" ? p.rootFreeBytes : null
      node.tmpFreeBytes = typeof p.tmpFreeBytes === "number" ? p.tmpFreeBytes : null
      node.rootTotalBytes = typeof p.rootTotalBytes === "number" ? p.rootTotalBytes : null
      node.tmpTotalBytes = typeof p.tmpTotalBytes === "number" ? p.tmpTotalBytes : null
      merged.push(node.displayName)
    }
  }
  nodesParsed.probedNames = merged
  return nodesParsed
}

// scriptText POST: longer timeout than polling actions — a sweep over a
// multi-hundred-GB workspace tree legitimately takes minutes. The script
// body rides --data-urlencode, never the URL. --fail-with-body (instead
// of -f) keeps the error body in stdout, so a 403 from a non-admin token
// surfaces as a readable permission message instead of a bare exit code.
function buildScriptCommand(script, jenkinsUrl, netrcPath, crumb) {
  var args = ["curl", "-sS", "--fail-with-body", "--max-time", "600", "--netrc-file", netrcPath,
    "-H", "Accept: application/json"]
  if (crumb) {
    args.push("-H", "Jenkins-Crumb: " + crumb)
  }
  args.push("-X", "POST", "--data-urlencode", "script=" + script,
    jhJoinUrl(jenkinsUrl, "/scriptText"))
  return args
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
    jobFolder: jobFolder,
    isNeverGreen: isNeverGreen,
    isDegrading: isDegrading,
    recentBuilds: recentBuilds,
    folderRollups: folderRollups,
    historyAppendPt: historyAppendPt,
    historyCompactPts: historyCompactPts,
    buildActionCommand: buildActionCommand,
    buildScriptCommand: buildScriptCommand,
    workspaceListScript: workspaceListScript,
    workspaceCleanScript: workspaceCleanScript,
    historyAppendDisk: historyAppendDisk,
    historyCompactDisk: historyCompactDisk,
    historyCompactDisks: historyCompactDisks,
    diskProbeScript: diskProbeScript,
    parseDiskProbe: parseDiskProbe,
    mergeProbeData: mergeProbeData,
    probeFreshMs: PROBE_FRESH_MS,
    historySeries: historySeries,
    sparklineSlots: sparklineSlots,
    buildNetrc: buildNetrc,
    buildCurlArgs: buildCurlArgs
  }
}
