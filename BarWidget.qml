import QtQuick
import qs.Ui
import qs.Commons
import "." as Local

// Jenkins Health bar widget (h3nr1.d14z.jenkins).
//
// A compact gauge chip: the health score colored by level. Left-click opens
// the detail panel, middle-click refreshes now. All settings from the
// manifest schema live in the widget's shell.json entry and are pushed to
// the shared service here (the service itself has no settings access).

BarWidget {
  id: root
  moduleName: "h3nr1.d14z.jenkins"

  readonly property var service: bar && bar.shell ? bar.shell.serviceFor(moduleName) : null

  readonly property string state: service ? service.state : "unconfigured"
  readonly property int score: service ? service.score : 0
  readonly property string version: service ? service.version : ""
  property bool popupOpen: false
  // Exposed so the E2E can drive PopupCard.close() — the exact call the
  // outside-click focus grab makes — and assert the chip survives it.
  readonly property var popupCard: popup

  function pushConfig() {
    if (!service || typeof service.applyConfig !== "function") return
    service.applyConfig({
      jenkinsUrl: String(setting("jenkinsUrl", "")),
      jenkinsUser: String(setting("jenkinsUser", "")),
      tokenFile: String(setting("tokenFile", "~/.config/jenkins-health/token")),
      refreshIntervalSec: setting("refreshIntervalSec", 30),
      queueBacklogThreshold: setting("queueBacklogThreshold", 10),
      diskWarnGb: setting("diskWarnGb", 25),
      diskCriticalGb: setting("diskCriticalGb", 10),
      responseTimeWarnMs: setting("responseTimeWarnMs", 1000),
      failurePenaltyCap: setting("failurePenaltyCap", 0),
      enableCleanWorkspace: setting("enableCleanWorkspace", "Off") !== "Off",
      notifyController: setting("notifyController", "On") !== "Off",
      notifyNodes: setting("notifyNodes", "On") !== "Off",
      notifyFailures: setting("notifyFailures", "On") !== "Off",
      notifyQueue: setting("notifyQueue", "On") !== "Off",
      notifyMaintenance: setting("notifyMaintenance", "On") !== "Off"
    })
  }

  // Register with the service so its single IPC target can relay panel
  // commands (open/close/toggle) to every monitor's widget instance.
  function attachService() {
    pushConfig()
    if (service && typeof service.registerWidget === "function") service.registerWidget(root)
  }

  function openPopup() { popupOpen = true }
  function closePopup() { popupOpen = false }
  function togglePopup() { popupOpen = !popupOpen }

  // PopupCard delegation contract — REQUIRED. Outside-click dismissal
  // (HyprlandFocusGrab.onCleared → PopupCard.close()) and the bar's popout
  // switch (Bar.requestPopout → closeForPopoutSwitch) route through close()
  // on the owner. Without it PopupCard.close() assigns its own `open`
  // directly, breaking the open:popupOpen binding — the chip then toggles a
  // dead property and stops responding to clicks until recreated.
  function close() { popupOpen = false }
  function closeForPopoutSwitch() { close() }

  Component.onCompleted: attachService()
  onSettingsChanged: pushConfig()
  onServiceChanged: attachService()
  Component.onDestruction: if (service && typeof service.unregisterWidget === "function") {
    service.unregisterWidget(root)
  }

  readonly property color statusColor: state === "critical" ? Color.urgent
    : state === "warn" ? Color.accent
    : state === "ok" ? (bar ? bar.barForeground : Color.foreground)
    : Color.muted

  readonly property string chipText: state === "unconfigured" ? "setup"
    : state === "noauth" ? "no token"
    : state === "starting" ? "…"
    : String(score)

  function tooltipText() {
    if (state === "unconfigured" || state === "noauth" || state === "starting") {
      return "Jenkins: " + (service && service.statusMessage ? service.statusMessage : "connecting…")
    }
    var s = service && service.snapshot ? service.snapshot : null
    if (!s) return "Jenkins: connecting…"
    var total = s.nodes ? s.nodes.length : 0
    var online = 0
    for (var i = 0; i < total; i++) {
      if (s.nodes[i].state === "online") online++
    }
    var text = "Jenkins " + (version || "?") + " · " + s.overall.level + " " + s.overall.score
      + " · nodes " + online + "/" + total + " · queue " + s.queue.depth
    if (s.queue.stuck > 0) text += " (" + s.queue.stuck + " stuck)"
    return text
  }

  implicitWidth: row.implicitWidth + Style.space(14)
  implicitHeight: barSize

  Row {
    id: row
    anchors.centerIn: parent
    spacing: Style.space(6)

    Image {
      anchors.verticalCenter: parent.verticalCenter
      // Official Jenkins logo (CC BY-SA 3.0, bundled as jenkins.svg).
      // Multicolor, so it carries the plugin identity while the score
      // text beside it carries the level color.
      source: "jenkins.svg"
      sourceSize.height: 36
      width: Style.space(16)
      height: Style.space(16)
      fillMode: Image.PreserveAspectFit
      smooth: true
    }


    // Vertical bars have no room for the label and the logo is multicolor,
    // so a small level-colored dot carries the state there.
    Rectangle {
      visible: root.vertical
      width: Style.space(4)
      height: Style.space(4)
      radius: Style.space(2)
      color: root.statusColor
    }

    Text {
      id: chipText
      anchors.verticalCenter: parent.verticalCenter
      // Horizontal bars: the score text carries the level color (the
      // logo is multicolor); vertical bars get the dot above, and the
      // tooltip carries the detail.
      visible: !root.vertical
      text: root.chipText
      color: root.statusColor
      font.family: root.bar ? root.bar.fontFamily : Style.font.family
      font.pixelSize: Style.font.body
      Behavior on color {
        enabled: !root.bar || root.bar.foregroundAnimationEnabled
        ColorAnimation { duration: 160 }
      }
    }
  }

  MouseArea {
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    acceptedButtons: Qt.LeftButton | Qt.MiddleButton

    onClicked: function(mouse) {
      if (mouse.button === Qt.MiddleButton) {
        if (root.service) root.service.refresh()
      } else {
        root.popupOpen = !root.popupOpen
      }
    }
    onEntered: if (root.bar) root.bar.showTooltip(root, root.tooltipText())
    onExited: if (root.bar) root.bar.hideTooltip(root)
  }

  PopupCard {
    id: popup
    anchorItem: root
    bar: root.bar
    owner: root
    open: root.popupOpen
    contentWidth: popup.fittedContentWidth(Style.space(420))
    contentHeight: popup.fittedContentHeight(panel.implicitHeight)

    Local.Panel {
      id: panel
      anchors.fill: parent
      service: root.service
      bar: root.bar
    }
  }
}
