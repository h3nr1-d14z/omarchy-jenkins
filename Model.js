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
  var diskCriticalOnline = 0
  var slowNodes = 0
  var score = 100

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
    if (minGb !== null && minGb < diskCriticalGb) {
      reasons.push("disk space critical: " + jhGbLabel(minGb) + " free")
      level = "critical"
      if (!isOffline) diskCriticalOnline++
      overallReasons.push("node " + node.displayName + " disk space critical: " + jhGbLabel(minGb) + " free")
    } else if (minGb !== null && minGb < diskWarnGb) {
      reasons.push("disk space low: " + jhGbLabel(minGb) + " free")
      if (level === "ok") level = "warn"
      overallReasons.push("node " + node.displayName + " disk space low: " + jhGbLabel(minGb) + " free")
    }

    // Dedicated disk tier for edge-triggered notifications: never derived
    // from `level`, which also folds offline/slow causes. An online node
    // whose monitors report no values is "unknown" — that is exactly the
    // state a filling disk hides behind. Offline nodes keep whatever the
    // (stale) values say, but diffEvents never diffs them, so no flapping.
    var diskTier = null
    if (minGb !== null) {
      diskTier = minGb < diskCriticalGb ? "critical" : (minGb < diskWarnGb ? "low" : "ok")
    } else if (!isOffline) {
      diskTier = "unknown"
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
      level: score >= 95 ? "ok" : score >= 50 ? "warn" : "critical",
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
// nodeOffline / nodeOnline / workspaceCleanup. `action` is either a
// descriptor object {action, targetId} or a plain string (with targetId
// as second argument).
//
// nodeWorkspaceList / nodeWorkspaceClean run fixed Groovy templates on
// the script console (requires an admin-scoped token): the node NAME is
// the only value ever interpolated into the script text. The clean
// script re-checks idleness and onlineness SERVER-SIDE (Computer.isIdle
// also covers one-off executors) so a stale panel cannot trigger a
// delete on a busy node.
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
  } else if (kind === "workspaceCleanup") {
    // Jenkins' built-in WorkspaceCleanupThread: retention-aware, skips
    // in-use and recent workspaces on every node. A plain POST like the
    // other safe actions.
    endpoint = "/doWorkspaceCleanup"
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
    "def n = 0",
    "ws.list().findAll { it.isDirectory() }.each { println('DIR ' + it.name); n++ }",
    "println('LISTED ' + n)"
  ].join("\n")
}

function workspaceCleanScript(nodeName) {
  return [
    "def c = Jenkins.instance.getComputer(" + jhGroovyString(nodeName) + ")",
    "if (c == null) { c = Jenkins.instance.computers.toList().find { it.displayName == " + jhGroovyString(nodeName) + " } }",
    "if (c == null) { println('NO_SUCH_COMPUTER'); return }",
    "if (!c.online) { println('NODE_OFFLINE'); return }",
    "if (!c.idle) { println('NODE_BUSY'); return }",
    "def ws = c.node != null ? c.node.rootPath : null",
    "if (ws != null) { ws = ws.child('workspace') }",
    "if (ws == null) { println('NO_WORKSPACE_ROOT'); return }",
    "def deleted = 0; def skipped = 0; def errors = 0",
    "ws.list().findAll { it.isDirectory() }.each { d ->",
    "  def building = false",
    "  try {",
    "    def item = Jenkins.instance.getItemByFullName(d.name)",
    "    if (item != null) { building = item.isBuilding() }",
    "  } catch (e) { building = false }",
    "  if (building) { skipped++ } else {",
    "    try { d.deleteRecursive(); deleted++ } catch (e) { errors++ }",
    "  }",
    "}",
    "println('RESULT deleted=' + deleted + ' skipped=' + skipped + ' errors=' + errors)"
  ].join("\n")
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
    historySeries: historySeries,
    sparklineSlots: sparklineSlots,
    buildNetrc: buildNetrc,
    buildCurlArgs: buildCurlArgs
  }
}
