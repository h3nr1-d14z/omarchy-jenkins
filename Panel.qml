import QtQuick
import qs.Ui
import qs.Commons

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

  // Active tab: "overview" | "nodes" | "jobs" | "queue".
  property string activeTab: "overview"

  readonly property var snap: service ? service.snapshot : null
  readonly property var ctrl: snap && snap.controller ? snap.controller : null
  readonly property var overall: snap ? snap.overall : null
  readonly property var nodes: snap && snap.nodes ? snap.nodes : []
  readonly property var queue: snap ? snap.queue : null
  readonly property var maintenance: snap ? snap.maintenance : null
  readonly property var queueItems: service ? service.queueItems : []
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

  function fmtGb(gb) {
    return gb === null || gb === undefined ? "?" : (Math.round(gb * 10) / 10) + "G"
  }

  function nodeColor(n) {
    return n.level === "critical" ? Color.urgent
      : n.level === "warn" ? Color.accent : foreground
  }

  function nodeStats(n) {
    return fmtGb(n.diskGb) + " · " + (n.responseTimeMs === null || n.responseTimeMs === undefined
      ? "?" : n.responseTimeMs + "ms")
      + " · " + (n.executorsTotal - n.executorsIdle) + "/" + n.executorsTotal
  }

  // The popup sizes to the ACTIVE tab's content (capped to the screen by
  // PopupCard.fittedContentHeight); inactive tabs stay instantiated so
  // switching is instant and state survives.
  function activeContentHeight() {
    if (activeTab === "nodes") return nodesCol.implicitHeight
    if (activeTab === "jobs") return jobsCol.implicitHeight
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
            height: Style.space(26)

            Text {
              id: nodeName
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              width: parent.width - nodeStats.width - nodeAction.width - Style.space(24)
              elide: Text.ElideRight
              text: (modelData.state === "offline" ? "○ " : "● ") + modelData.displayName
              color: root.nodeColor(modelData)
              font.family: Style.font.family
              font.pixelSize: Style.font.body
            }

            Text {
              id: nodeStats
              anchors.right: nodeAction.left
              anchors.rightMargin: Style.space(8)
              anchors.verticalCenter: parent.verticalCenter
              text: root.nodeStats(modelData)
              color: Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
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
            : ""
          color: root.ctrl && root.ctrl.failures > 0 ? Color.urgent : Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }

        Repeater {
          model: root.ctrl && root.ctrl.failingNames ? root.ctrl.failingNames : []

          Item {
            width: parent.width
            height: Style.space(22)

            Text {
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              width: parent.width - Style.space(8)
              elide: Text.ElideRight
              text: "✗ " + modelData
              color: Color.urgent
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
            }
          }
        }

        Repeater {
          model: root.ctrl && root.ctrl.unstableNames ? root.ctrl.unstableNames : []

          Item {
            width: parent.width
            height: Style.space(22)

            Text {
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              width: parent.width - Style.space(8)
              elide: Text.ElideRight
              text: "△ " + modelData
              color: Color.accent
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
            }
          }
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
