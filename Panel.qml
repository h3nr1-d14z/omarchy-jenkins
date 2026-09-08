import QtQuick
import qs.Ui
import qs.Commons
import "Model.js" as Model


// Jenkins Health detail panel, hosted inside the BarWidget's PopupCard.
// Shows the latest assessment and offers the safe actions: quiet-down
// toggle, cancel a queue item, node online/offline. All data comes from
// the shared service instance.
//
// Layout: fixed header (identity + level chip), a tab bar, and a single
// scrollable content area — only the active tab's content sizes the
// popup, so a controller with dozens of failing jobs or nodes cannot
// overflow the screen; each list scrolls instead. The footer (refresh +
// status/action feedback) stays pinned.

Item {
  id: root

  property var service: null
  property var bar: null

  // Active tab: "overview" | "nodes" | "jobs" | "activity" | "queue".
  property string activeTab: "overview"

  readonly property var snap: service ? service.snapshot : null
  readonly property var ctrl: snap && snap.controller ? snap.controller : null
  readonly property var overall: snap ? snap.overall : null
  readonly property var nodes: snap && snap.nodes ? snap.nodes : []
  readonly property var queue: snap ? snap.queue : null
  readonly property var maintenance: snap ? snap.maintenance : null
  readonly property var queueItems: service ? service.queueItems : []
  readonly property var jobs: root.ctrl && root.ctrl.jobs ? root.ctrl.jobs : []
  readonly property var recent: root.ctrl && root.ctrl.recent ? root.ctrl.recent : []
  readonly property var rollups: root.ctrl && root.ctrl.rollups ? root.ctrl.rollups : []

  // Sparkline windows recompute whenever the service publishes a new
  // point (lastUpdated ticks every successful poll).
  readonly property real historyNowSec: root.service && root.service.lastUpdated
    ? Math.floor(Date.now() / 1000) : 0
  readonly property var scoreSlots: root.historyNowSec > 0 && root.service
    ? Model.sparklineSlots(Model.historySeries(root.service.historyPts, "s"),
        root.historyNowSec, 86400, 24)
    : []
  readonly property var queueSlots: root.historyNowSec > 0 && root.service
    ? Model.sparklineSlots(Model.historySeries(root.service.historyPts, "q"),
        root.historyNowSec, 86400, 24)
    : []
  readonly property real diskCriticalGb: root.service && root.service.config
    && root.service.config.diskCriticalGb ? root.service.config.diskCriticalGb : 10
  readonly property real diskWarnGb: root.service && root.service.config
    && root.service.config.diskWarnGb ? root.service.config.diskWarnGb : 25

  readonly property string state: service ? service.state : "unconfigured"
  readonly property bool actionsEnabled: !!service
    && state !== "unconfigured" && state !== "noauth" && state !== "starting"
  readonly property color foreground: bar ? bar.barForeground : Color.foreground
  readonly property color levelColor: state === "critical" ? Color.urgent
    : state === "warn" ? Color.accent
    : state === "ok" ? foreground : Color.muted

  function fmtAge(sec) {
    if (sec < 60) return sec + "s"
    if (sec < 3600) return Math.floor(sec / 60) + "m"
    return Math.floor(sec / 3600) + "h" + Math.floor((sec % 3600) / 60) + "m"
  }

  function fmtDur(ms) {
    var s = Math.round((ms || 0) / 1000)
    if (s < 60) return s + "s"
    if (s < 3600) return Math.floor(s / 60) + "m" + ("0" + (s % 60)).slice(-2) + "s"
    return Math.floor(s / 3600) + "h" + Math.floor((s % 3600) / 60) + "m"
  }

  // Worst first: never-green, then lowest health, then most recent build.
  function jobSeveritySort(a, b) {
    var na = Model.isNeverGreen(a) ? 0 : 1
    var nb = Model.isNeverGreen(b) ? 0 : 1
    if (na !== nb) return na - nb
    var ha = a.health === null || a.health === undefined ? 101 : a.health
    var hb = b.health === null || b.health === undefined ? 101 : b.health
    if (ha !== hb) return ha - hb
    var ta = a.lastBuild ? a.lastBuild.timestamp : 0
    var tb = b.lastBuild ? b.lastBuild.timestamp : 0
    return tb - ta
  }

  function failingJobList() {
    return root.jobs.filter(function (j) {
      return j.color === "red" || j.color === "red_anime"
    }).sort(root.jobSeveritySort)
  }

  function unstableJobList() {
    return root.jobs.filter(function (j) {
      return j.color === "yellow" || j.color === "yellow_anime"
    }).sort(root.jobSeveritySort)
  }

  function folderRollupList() {
    return root.rollups.filter(function (r) { return r.folder !== "" })
  }

  function jobMeta(j) {
    var parts = []
    if (j.health !== null && j.health !== undefined) parts.push("h" + j.health)
    if (Model.isNeverGreen(j)) parts.push("never green")
    if (j.lastBuild) {
      if (!Model.isNeverGreen(j)) parts.push("#" + j.lastBuild.number)
      parts.push(root.fmtDur(j.lastBuild.duration))
      if (j.lastBuild.timestamp > 0) {
        parts.push(root.fmtAge(Math.max(0, Math.round((Date.now() - j.lastBuild.timestamp) / 1000))) + " ago")
      }
    }
    return parts.join(" · ")
  }

  function buildMeta(b) {
    if (b.building) return root.fmtDur(b.durationMs) + " so far"
    return "#" + b.number + " · " + root.fmtDur(b.durationMs) + " · "
      + root.fmtAge(Math.max(0, Math.round((Date.now() - b.timestamp) / 1000))) + " ago"
  }

  function scoreBarColor(v) {
    return v >= 95 ? root.foreground : v >= 50 ? Color.accent : Color.urgent
  }

  function diskBarColor(v) {
    return v <= root.diskCriticalGb ? Color.urgent
      : v <= root.diskWarnGb ? Color.accent : root.foreground
  }

  function nodeDiskSlots(n) {
    if (!root.service || !root.service.historyDisks || root.historyNowSec <= 0) return []
    var series = root.service.historyDisks[n.displayName]
    if (!series) return []
    return Model.sparklineSlots(series, root.historyNowSec, 86400, 20)
  }

  // Bar sparkline: one bar per slot, newest value per slot wins, empty
  // slots render as faint stubs so gaps stay readable.
  component Sparkline: Item {
    id: spark
    property var slots: []
    property real maxValue: 100
    property color baseColor: Color.accent
    property var barColor: null

    width: Style.space(150)
    height: Style.space(14)

    Row {
      anchors.fill: parent
      spacing: 1

      Repeater {
        model: spark.slots

        Item {
          width: spark.slots.length > 0
            ? Math.max(1, Math.floor((spark.width - (spark.slots.length - 1)) / spark.slots.length))
            : 1
          height: spark.height

          Rectangle {
            anchors.bottom: parent.bottom
            width: parent.width
            height: modelData === null ? 1
              : Math.max(2, parent.height * Math.max(0, Math.min(1, modelData / spark.maxValue)))
            color: modelData === null
              ? Qt.alpha(spark.baseColor, 0.25)
              : (spark.barColor ? spark.barColor(modelData) : spark.baseColor)
            radius: 1
          }
        }
      }
    }
  }

  function fmtGb(gb) {
    return gb === null || gb === undefined ? "?" : (Math.round(gb * 10) / 10) + "G"
  }

  function nodeColor(n) {
    return n.level === "critical" ? Color.urgent
      : n.level === "warn" ? Color.accent : foreground
  }

  function nodeStats(n) {
    return fmtGb(n.diskGb) + " · " + fmtGb(n.tmpGb) + " tmp · "
      + (n.responseTimeMs === null || n.responseTimeMs === undefined
        ? "?" : n.responseTimeMs + "ms")
      + " · " + (n.executorsTotal - n.executorsIdle) + "/" + n.executorsTotal
      + ((n.oneOffBusy || 0) > 0 ? " +" + n.oneOffBusy : "")
  }

  // Workspace cleanup is off by default (script-console actions need an
  // admin-scoped token); the per-node buttons only render when the user
  // turned the feature on in the plugin settings.
  readonly property bool cleanWorkspaceEnabled: root.service && root.service.config
    && root.service.config.enableCleanWorkspace === true

  function nodeWorkspacePreview(n) {
    var p = root.service ? root.service.workspacePreview : null
    return p && p.node === n.displayName ? p : null
  }

  // The popup sizes to the ACTIVE tab's content (capped to the screen by
  // PopupCard.fittedContentHeight); inactive tabs stay instantiated so
  // switching is instant and state survives.
  function activeContentHeight() {
    if (activeTab === "nodes") return nodesCol.implicitHeight
    if (activeTab === "jobs") return jobsCol.implicitHeight
    if (activeTab === "activity") return activityCol.implicitHeight
    if (activeTab === "queue") return queueCol.implicitHeight
    return overviewCol.implicitHeight
  }

  implicitHeight: headerRow.height + footerRow.height + Style.space(20)
    + (snap ? tabBar.height + Style.space(10) + activeContentHeight()
      : setupHint.implicitHeight)

  // ---- fixed header

  Item {
    id: headerRow
    anchors.top: parent.top
    anchors.left: parent.left
    anchors.right: parent.right
    height: Math.max(headerLogo.height, headerTexts.implicitHeight, levelChip.height)

    Image {
      id: headerLogo
      anchors.left: parent.left
      anchors.verticalCenter: parent.verticalCenter
      source: "jenkins.svg"
      // official Jenkins logo (CC BY-SA 3.0); rasterized 2x for crispness
      sourceSize.height: 40
      width: Style.space(22)
      height: Style.space(22)
      fillMode: Image.PreserveAspectFit
      smooth: true
    }

    Column {
      id: headerTexts
      anchors.left: headerLogo.right
      anchors.leftMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)

      Text {
        // Show the version only when it is a real one; during an
        // outage there is no version to show and a bare "Jenkins"
        // reads far better than "Jenkins ?".
        text: root.ctrl && root.ctrl.version && root.ctrl.version !== "Unknown"
          ? "Jenkins " + root.ctrl.version : "Jenkins"
        color: root.foreground
        font.family: Style.font.family
        font.pixelSize: Style.font.title
      }
      Text {
        text: root.service && root.service.lastUpdated
          ? "updated " + root.service.lastUpdated
          : (root.service && root.service.statusMessage ? root.service.statusMessage : "connecting…")
        color: Color.muted
        font.family: Style.font.family
        font.pixelSize: Style.font.bodySmall
      }
    }

    Rectangle {
      id: levelChip
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      radius: Style.cornerRadius
      border.color: root.levelColor
      border.width: 1
      width: levelChipText.implicitWidth + Style.space(10)
      height: levelChipText.implicitHeight + Style.space(4)

      Text {
        id: levelChipText
        anchors.centerIn: parent
        text: root.overall ? root.overall.level + " · " + root.overall.score
          : (root.state === "unconfigured" ? "setup" : root.state === "noauth" ? "no token" : "…")
        color: root.levelColor
        font.family: Style.font.family
        font.pixelSize: Style.font.bodySmall
      }
    }
  }

  // ---- setup hint before the first snapshot

  Text {
    id: setupHint
    visible: !root.snap
    anchors.top: headerRow.bottom
    anchors.topMargin: Style.space(8)
    width: parent.width
    wrapMode: Text.Wrap
    color: Color.muted
    font.family: Style.font.family
    font.pixelSize: Style.font.bodySmall
    text: root.service && root.service.statusMessage
      ? root.service.statusMessage
      : "Set jenkinsUrl and jenkinsUser in the widget settings, then create the token file (see README)."
  }

  // ---- tab bar

  Row {
    id: tabBar
    visible: !!root.snap
    anchors.top: headerRow.bottom
    anchors.topMargin: Style.space(8)
    anchors.left: parent.left
    spacing: Style.space(4)

    Button {
      text: "Overview"
      fontSize: Style.font.bodySmall
      selected: root.activeTab === "overview"
      onClicked: root.activeTab = "overview"
    }

    Button {
      text: "Nodes" + (root.nodes.length > 0 ? " · " + root.nodes.length : "")
      fontSize: Style.font.bodySmall
      selected: root.activeTab === "nodes"
      onClicked: root.activeTab = "nodes"
    }

    Button {
      text: "Jobs" + (root.ctrl && root.ctrl.failures > 0 ? " · " + root.ctrl.failures : "")
      fontSize: Style.font.bodySmall
      foreground: root.ctrl && root.ctrl.failures > 0 ? Color.urgent : Color.foreground
      selected: root.activeTab === "jobs"
      onClicked: root.activeTab = "jobs"
    }

    Button {
      text: "Activity"
      fontSize: Style.font.bodySmall
      selected: root.activeTab === "activity"
      onClicked: root.activeTab = "activity"
    }

    Button {
      text: "Queue" + (root.queue && root.queue.depth > 0 ? " · " + root.queue.depth : "")
      fontSize: Style.font.bodySmall
      selected: root.activeTab === "queue"
      onClicked: root.activeTab = "queue"
    }
  }

  // ---- scrollable tab content

  Flickable {
    id: flick
    visible: !!root.snap
    anchors.top: tabBar.bottom
    anchors.topMargin: Style.space(6)
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: footerRow.top
    anchors.bottomMargin: Style.space(4)
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    contentHeight: contentCol.implicitHeight + Style.space(4)
    interactive: contentHeight > height

    Column {
      id: contentCol
      width: flick.width
      spacing: Style.space(8)

      // == overview tab: attention summary + maintenance

      Column {
        id: overviewCol
        visible: root.activeTab === "overview"
        width: parent.width
        spacing: Style.space(8)

        Column {
          visible: !!root.overall && root.overall.reasons.length > 0
          width: parent.width
          spacing: Style.space(2)

          PanelSectionHeader { text: "Attention" }

          Repeater {
            model: root.overall && root.overall.reasons ? root.overall.reasons : []

            Text {
              width: parent.width
              wrapMode: Text.WordWrap
              elide: Text.ElideRight
              maximumLineCount: 2
              text: "• " + modelData
              color: root.levelColor === Color.muted ? Color.accent : root.levelColor
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
            }
          }
        }

        Column {
          visible: root.folderRollupList().length > 0
          width: parent.width
          spacing: Style.space(2)

          PanelSectionHeader { text: "Folders" }

          Repeater {
            model: root.folderRollupList().slice(0, 3)

            Text {
              width: parent.width
              elide: Text.ElideRight
              text: modelData.folder + " · " + modelData.failing + " failing"
                + (modelData.worstHealth !== null && modelData.worstHealth !== undefined
                  ? " · worst h" + modelData.worstHealth : "")
                + (modelData.neverGreen > 0 ? " · " + modelData.neverGreen + " never green" : "")
                + " · " + modelData.total + " jobs"
              color: modelData.failing > 0 ? Color.urgent : Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
            }
          }
        }

        Column {
          visible: root.historyNowSec > 0
            && root.scoreSlots.some(function (v) { return v !== null })
          width: parent.width
          spacing: Style.space(4)

          PanelSectionHeader { text: "Trend" }

          Item {
            width: parent.width
            height: scoreSpark.height

            Text {
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              text: "Score · 24h"
              color: Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
            }

            Sparkline {
              id: scoreSpark
              anchors.right: parent.right
              slots: root.scoreSlots
              maxValue: 100
              baseColor: Color.accent
              barColor: root.scoreBarColor
            }
          }

          Item {
            width: parent.width
            height: queueSpark.height

            Text {
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              text: "Queue · 24h"
              color: Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
            }

            Sparkline {
              id: queueSpark
              anchors.right: parent.right
              slots: root.queueSlots
              maxValue: Math.max(1, Math.max.apply(null,
                root.queueSlots.filter(function (v) { return v !== null }).concat([1])))
              baseColor: Color.accent
            }
          }
        }

        Column {
          visible: !!root.maintenance
          width: parent.width
          spacing: Style.space(4)

          PanelSectionHeader { text: "Maintenance" }

          Text {
            width: parent.width
            wrapMode: Text.Wrap
            text: root.maintenance
              ? (root.maintenance.quietingDown ? "quiet-down active\n" : "")
                + root.maintenance.updatesAvailable + " plugin updates"
                + (root.maintenance.restartRequired ? " · restart required" : "")
              : ""
            color: Color.muted
            font.family: Style.font.family
            font.pixelSize: Style.font.bodySmall
          }

          Button {
            text: root.maintenance && root.maintenance.quietingDown
              ? "Cancel quiet-down" : "Quiet down"
            enabled: root.actionsEnabled
            onClicked: if (root.service) {
              root.service.runAction(
                root.maintenance && root.maintenance.quietingDown
                  ? "cancelQuietDown" : "quietDown", null)
            }
          }

        }

        Text {
          visible: !root.overall || root.overall.reasons.length === 0
          text: "All clear — nothing needs attention."
          color: Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }
      }

      // == nodes tab

      Column {
        id: nodesCol
        visible: root.activeTab === "nodes"
        width: parent.width
        spacing: Style.space(2)

        PanelSectionHeader { text: "Nodes" }

        Text {
          visible: root.nodes.length === 0
          text: "no nodes visible"
          color: Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }

        Repeater {
          model: root.nodes

          Item {
            width: parent.width
            height: nodeLine.height
              + (nodeDisk.visible ? nodeDisk.height + Style.space(2) : 0)
              + (nodePreview.visible ? nodePreview.height + Style.space(2) : 0)

            Item {
              id: nodeLine
              width: parent.width
              height: Style.space(26)

              Text {
                id: nodeName
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                width: parent.width - nodeStats.width - nodeClean.width - nodeAction.width - Style.space(24)
                elide: Text.ElideRight
                text: (modelData.state === "offline" ? "○ " : "● ") + modelData.displayName
                color: root.nodeColor(modelData)
                font.family: Style.font.family
                font.pixelSize: Style.font.body
              }
              Text {
                id: nodeStats
                anchors.right: nodeClean.left
                anchors.rightMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                text: root.nodeStats(modelData)
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }
              Button {
                id: nodeClean
                visible: root.cleanWorkspaceEnabled && modelData.state === "online"
                width: visible ? implicitWidth : 0
                anchors.right: nodeAction.left
                anchors.rightMargin: Style.space(4)
                anchors.verticalCenter: parent.verticalCenter
                text: "Clean ws"
                fontSize: Style.font.bodySmall
                enabled: root.actionsEnabled
                onClicked: if (root.service) {
                  root.service.runAction("nodeWorkspaceList", modelData.displayName)
                }
              }

              Button {
                id: nodeAction
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                text: modelData.state === "online" ? "Take offline" : "Bring online"
                fontSize: Style.font.bodySmall
                enabled: root.actionsEnabled
                onClicked: if (root.service) {
                  root.service.runAction(
                    modelData.state === "online" ? "nodeOffline" : "nodeOnline",
                    modelData.displayName)
                }
              }
            }

            // 24h disk trend under the node line, only when the
            // service has history for this node.
            Item {
              id: nodeDisk
              visible: root.nodeDiskSlots(modelData).some(function (v) { return v !== null })
              anchors.top: nodeLine.bottom
              anchors.topMargin: Style.space(2)
              width: parent.width
              height: Style.space(10)

              Text {
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                text: "disk 24h"
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }

              Sparkline {
                anchors.right: parent.right
                width: Style.space(120)
                height: parent.height
                slots: root.nodeDiskSlots(modelData)
                maxValue: Math.max(1, Math.max.apply(null,
                  root.nodeDiskSlots(modelData).filter(function (v) { return v !== null }).concat([1])))
                baseColor: root.foreground
                barColor: root.diskBarColor
              }
            }

            // Workspace-cleanup dry-run and confirm row. "Clean ws" set
            // the service's workspacePreview for this node; the Delete
            // button is the explicit second step, and the server-side
            // script still re-checks that the node is online and idle
            // before deleting anything. Scope: workspaces under this
            // node's default workspace root only.
            Item {
              id: nodePreview
              visible: root.cleanWorkspaceEnabled && !!root.nodeWorkspacePreview(modelData)
              anchors.top: nodeLine.bottom
              anchors.topMargin: nodeDisk.visible
                ? nodeDisk.height + Style.space(4) : Style.space(2)
              width: parent.width
              height: previewCol.implicitHeight

              Column {
                id: previewCol
                width: parent.width
                spacing: Style.space(2)

                Text {
                  width: parent.width
                  wrapMode: Text.Wrap
                  visible: root.nodeWorkspacePreview(modelData)
                    && root.nodeWorkspacePreview(modelData).error !== ""
                  text: {
                    var p = root.nodeWorkspacePreview(modelData)
                    return p && p.error ? "workspace list failed: " + p.error : ""
                  }
                  color: Color.urgent
                  font.family: Style.font.family
                  font.pixelSize: Style.font.bodySmall
                }

                Text {
                  width: parent.width
                  wrapMode: Text.Wrap
                  maximumLineCount: 3
                  elide: Text.ElideRight
                  visible: root.nodeWorkspacePreview(modelData)
                    && !root.nodeWorkspacePreview(modelData).error
                  text: {
                    var p = root.nodeWorkspacePreview(modelData)
                    return p ? p.dirs.length
                      + " workspace dirs under this node's default root: "
                      + (p.dirs.length > 0 ? p.dirs.join(", ") : "(none)") : ""
                  }
                  color: Color.muted
                  font.family: Style.font.family
                  font.pixelSize: Style.font.bodySmall
                }

                Row {
                  spacing: Style.space(4)
                  visible: root.nodeWorkspacePreview(modelData)
                    && !root.nodeWorkspacePreview(modelData).error
                    && root.nodeWorkspacePreview(modelData).dirs.length > 0

                  Button {
                    text: {
                      var p = root.nodeWorkspacePreview(modelData)
                      return "Delete (" + (p ? p.dirs.length : 0) + ")"
                    }
                    foreground: Color.urgent
                    fontSize: Style.font.bodySmall
                    enabled: root.actionsEnabled
                    onClicked: if (root.service) {
                      root.service.runAction("nodeWorkspaceClean", modelData.displayName)
                    }
                  }

                  Button {
                    text: "Cancel"
                    fontSize: Style.font.bodySmall
                    onClicked: if (root.service) root.service.clearWorkspacePreview()
                  }
                }
              }
            }
          }
        }
      }

      // == jobs tab

      Column {
        id: jobsCol
        visible: root.activeTab === "jobs"
        width: parent.width
        spacing: Style.space(2)

        PanelSectionHeader { text: "Jobs" }

        Text {
          width: parent.width
          wrapMode: Text.Wrap
          text: root.ctrl
            ? root.ctrl.failures + " failing · " + root.ctrl.unstable + " unstable · "
              + root.ctrl.building + " building"
              + (root.ctrl.neverGreen > 0 ? " · " + root.ctrl.neverGreen + " never green" : "")
              + (root.ctrl.degrading > 0 ? " · " + root.ctrl.degrading + " degrading" : "")
            : ""
          color: root.ctrl && root.ctrl.failures > 0 ? Color.urgent : Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }

        Repeater {
          model: root.failingJobList().slice(0, 50)

          Item {
            width: parent.width
            height: Style.space(22)

            Text {
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              width: parent.width - failMeta.width - Style.space(8)
              elide: Text.ElideRight
              text: "✗ " + modelData.name
              color: Color.urgent
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
            }

            Text {
              id: failMeta
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              text: root.jobMeta(modelData)
              color: Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
            }
          }
        }

        Text {
          visible: root.failingJobList().length > 50
          text: "+ " + (root.failingJobList().length - 50) + " more failing…"
          color: Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }

        Repeater {
          model: root.unstableJobList().slice(0, 20)

          Item {
            width: parent.width
            height: Style.space(22)

            Text {
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              width: parent.width - unMeta.width - Style.space(8)
              elide: Text.ElideRight
              text: "△ " + modelData.name
              color: Color.accent
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
            }

            Text {
              id: unMeta
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              text: root.jobMeta(modelData)
              color: Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
            }
          }
        }

        Text {
          visible: root.unstableJobList().length > 20
          text: "+ " + (root.unstableJobList().length - 20) + " more unstable…"
          color: Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }

        Repeater {
          model: root.ctrl && root.ctrl.buildingNames ? root.ctrl.buildingNames : []

          Item {
            width: parent.width
            height: Style.space(22)

            Text {
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              width: parent.width - Style.space(8)
              elide: Text.ElideRight
              text: "↻ " + modelData
              color: Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
            }
          }
        }

        Text {
          visible: root.ctrl && root.ctrl.failures === 0
            && root.ctrl.unstable === 0 && root.ctrl.building === 0
          text: "no failing, unstable, or building jobs"
          color: Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }
      }

      // == activity tab

      Column {
        id: activityCol
        visible: root.activeTab === "activity"
        width: parent.width
        spacing: Style.space(2)

        PanelSectionHeader { text: "Activity" }

        Text {
          width: parent.width
          text: "last build per job · newest first"
          color: Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }

        Repeater {
          model: root.recent

          Item {
            width: parent.width
            height: Style.space(22)

            Text {
              id: actGlyph
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              width: Style.space(14)
              text: modelData.building ? "↻"
                : modelData.result === "SUCCESS" ? "●"
                : modelData.result === "FAILURE" ? "✗"
                : modelData.result === "UNSTABLE" ? "△" : "○"
              color: modelData.building ? Color.muted
                : modelData.result === "SUCCESS" ? root.foreground
                : modelData.result === "FAILURE" ? Color.urgent
                : modelData.result === "UNSTABLE" ? Color.accent : Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
            }

            Text {
              anchors.left: actGlyph.right
              anchors.verticalCenter: parent.verticalCenter
              width: parent.width - actMeta.width - Style.space(22)
              elide: Text.ElideRight
              text: modelData.name
              color: root.foreground
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
            }

            Text {
              id: actMeta
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              text: root.buildMeta(modelData)
              color: Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
            }
          }
        }

        Text {
          visible: root.recent.length === 0
          text: "no build data available"
          color: Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }
      }

      // == queue tab

      Column {
        id: queueCol
        visible: root.activeTab === "queue"
        width: parent.width
        spacing: Style.space(2)

        PanelSectionHeader { text: "Queue" }

        Text {
          text: root.queue
            ? root.queue.depth + " waiting · " + root.queue.stuck + " stuck · oldest "
              + root.fmtAge(root.queue.oldestSec)
              + (root.queue.backlog ? " · backlog" : "")
            : ""
          color: root.queue && root.queue.backlog ? Color.accent : Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }

        Repeater {
          model: root.queueItems.length > 30 ? root.queueItems.slice(0, 30) : root.queueItems

          Item {
            width: parent.width
            height: Style.space(24)

            // Stuck marker: a red STUCK badge instead of a "!" prefix —
            // scannable at a glance. Zero-width when not stuck so the
            // name anchors cleanly in both states.
            Rectangle {
              id: stuckBadge
              visible: modelData.stuck
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              width: visible ? stuckLabel.implicitWidth + Style.space(6) : 0
              height: stuckLabel.implicitHeight + Style.space(2)
              radius: Style.cornerRadius
              color: Color.urgent

              Text {
                id: stuckLabel
                anchors.centerIn: parent
                text: "STUCK"
                color: Color.popups.text
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }
            }

            Text {
              id: queueName
              anchors.left: stuckBadge.right
              anchors.leftMargin: stuckBadge.visible ? Style.space(6) : 0
              anchors.verticalCenter: parent.verticalCenter
              width: parent.width - queueMeta.width - queueAction.width
                - stuckBadge.width - Style.space(24)
                - (stuckBadge.visible ? Style.space(6) : 0)
              elide: Text.ElideRight
              text: (modelData.name || "item " + modelData.id)
                + (modelData.why ? " — " + modelData.why : "")
              color: modelData.stuck ? Color.urgent : root.foreground
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
            }

            Text {
              id: queueMeta
              anchors.right: queueAction.left
              anchors.rightMargin: Style.space(8)
              anchors.verticalCenter: parent.verticalCenter
              text: root.fmtAge(Math.max(0, Math.round((Date.now() - modelData.inQueueSince) / 1000)))
              color: Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
            }

            Button {
              id: queueAction
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              text: "Cancel"
              fontSize: Style.font.bodySmall
              enabled: root.actionsEnabled
              onClicked: if (root.service) root.service.runAction("cancelQueueItem", modelData.id)
            }
          }
        }

        Text {
          visible: root.queueItems.length > 30
          text: "+ " + (root.queueItems.length - 30) + " more…"
          color: Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }

        Text {
          visible: root.queueItems.length === 0
          text: "queue is empty"
          color: Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }
      }
    }
  }

  // ---- pinned footer

  Item {
    id: footerRow
    anchors.bottom: parent.bottom
    anchors.left: parent.left
    anchors.right: parent.right
    height: refreshButton.height

    Button {
      id: refreshButton
      anchors.left: parent.left
      text: root.service && root.service.busy ? "Refreshing…" : "Refresh"
      enabled: !!root.service && !root.service.busy
      onClicked: if (root.service) root.service.refresh()
    }

    Text {
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      // State messages (config/auth problems) take precedence; action
      // feedback ("action sent") persists until the next action or
      // reconfiguration, surviving the auto-refresh poll.
      visible: root.service && (root.service.statusMessage || root.service.actionMessage)
      text: root.service
        ? (root.service.statusMessage || root.service.actionMessage) : ""
      color: Color.muted
      font.family: Style.font.family
      font.pixelSize: Style.font.bodySmall
    }
  }
}
