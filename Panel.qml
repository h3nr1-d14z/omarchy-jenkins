import QtQuick
import qs.Ui
import qs.Commons

// Jenkins Health detail panel, hosted inside the BarWidget's PopupCard.
// Shows the latest assessment (controller, nodes, queue, jobs, maintenance)
// and offers the safe actions: quiet-down toggle, cancel a queue item,
// node online/offline. All data comes from the shared service instance.

Item {
  id: root

  property var service: null
  property var bar: null

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

  implicitHeight: flick.contentHeight

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

  Flickable {
    id: flick
    anchors.fill: parent
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    contentHeight: column.implicitHeight + Style.space(4)
    interactive: contentHeight > height

    Column {
      id: column
      width: flick.width
      spacing: Style.space(8)

      // ---- header
      Item {
        width: parent.width
        height: Math.max(headerGlyph.height, headerTexts.implicitHeight, levelChip.height)

        Text {
          id: headerGlyph
          anchors.left: parent.left
          anchors.verticalCenter: parent.verticalCenter
          text: "󰓅"
          color: root.levelColor
          font.family: Style.font.family
          font.pixelSize: Style.font.title
        }

        Column {
          id: headerTexts
          anchors.left: headerGlyph.right
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
        visible: !root.snap
        width: parent.width
        wrapMode: Text.Wrap
        color: Color.muted
        font.family: Style.font.family
        font.pixelSize: Style.font.bodySmall
        text: root.service && root.service.statusMessage
          ? root.service.statusMessage
          : "Set jenkinsUrl and jenkinsUser in the widget settings, then create the token file (see README)."
      }

      // ---- attention reasons
      Column {
        visible: !!root.snap && !!root.overall && root.overall.reasons.length > 0
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

      // ---- nodes
      Column {
        visible: !!root.snap
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

      // ---- queue
      Column {
        visible: !!root.snap && !!root.queue
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
          model: root.queueItems.length > 6 ? root.queueItems.slice(0, 6) : root.queueItems

          Item {
            width: parent.width
            height: Style.space(24)

            Text {
              id: queueName
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              width: parent.width - queueMeta.width - queueAction.width - Style.space(24)
              elide: Text.ElideRight
              text: (modelData.stuck ? "! " : "") + (modelData.name || "item " + modelData.id)
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
          visible: root.queueItems.length > 6
          text: "+ " + (root.queueItems.length - 6) + " more…"
          color: Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }
      }

      // ---- jobs
      Column {
        visible: !!root.ctrl
        width: parent.width
        spacing: Style.space(2)

        PanelSectionHeader { text: "Jobs" }

        Text {
          width: parent.width
          wrapMode: Text.Wrap
          text: root.ctrl
            ? root.ctrl.failures + " failing · " + root.ctrl.unstable + " unstable · "
              + root.ctrl.building + " building"
              + (root.ctrl.failingNames && root.ctrl.failingNames.length > 0
                ? "\n" + root.ctrl.failingNames.join(", ") : "")
            : ""
          color: root.ctrl && root.ctrl.failures > 0 ? Color.urgent : Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }
      }

      // ---- maintenance + actions
      Column {
        visible: !!root.snap && !!root.maintenance
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

      // ---- footer
      Item {
        width: parent.width
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
  }
}
