import QtQuick
import Quickshell
import Quickshell.Io

// Runtime E2E widget harness: loads the REAL BarWidget.qml (which in turn
// loads Panel.qml through its PopupCard) in a standalone Quickshell
// instance, wired to the real Service via a fake bar host. This exercises
// the production configuration path — widget settings → applyConfig →
// service — plus the widget registry and the IPC panel-open relay.
//
// Timeline (driven by run.sh):
//   t=0     launch; widget registers with the service and pushes settings
//   t=4.0   dump W1: registry size, widget state, chip text
//   t=4.5   bash: qs ipc call jenkins-health open
//   t=6.5   dump W2: popupOpen flag (the relay landed) and quit

ShellRoot {
  id: app

  Service {
    id: service
  }

  // Fake shell host: provides exactly the surface BarWidget and its
  // PopupCard expect from the real bar (service discovery, theme/geometry,
  // tooltip stubs, and the popout coordinator).
  QtObject {
    id: fakeShell

    function serviceFor(pluginId) {
      return service
    }
  }

  QtObject {
    id: fakeBarHost

    property var shell: fakeShell
    property color barForeground: "#cccccc"
    property string fontFamily: "monospace"
    property bool vertical: false
    property int barSize: 30
    property bool foregroundAnimationEnabled: true
    property var activePopout: null

    function showTooltip(item, text) {}
    function hideTooltip(item) {}
    function requestPopout(key) {}
    function releasePopout(key) {}
  }

  BarWidget {
    id: widget
    bar: fakeBarHost

    // Production settings flow: the widget reads its shell.json-style
    // settings (injected here directly) and pushes them to the service
    // through applyConfig — no direct service configuration in this file.
    settings: ({
      jenkinsUrl: "http://127.0.0.1:28888",
      jenkinsUser: "e2e-user",
      tokenFile: Quickshell.env("JH_E2E_TOKEN_FILE") || "/tmp/jenkins-e2e/token",
      refreshIntervalSec: 30,
      queueBacklogThreshold: 10,
      diskWarnGb: 25,
      diskCriticalGb: 10,
      responseTimeWarnMs: 1000,
      enableCleanWorkspace: "On",
      enableDiskProbe: "On"
    })
  }

  Timer {
    interval: 4000
    running: true
    repeat: false
    onTriggered: {
      console.log("JH-E2E-W1 " + JSON.stringify({
        registered: service.widgets.length,
        widgetState: widget.state,
        chipText: widget.chipText,
        serviceState: service.state,
        score: service.score,
        cleanWired: service.config.enableCleanWorkspace === true,
        diskProbeWired: service.config.enableDiskProbe === true
      }))
    }
  }

  // Relay proof: dump right after the bash-side IPC open (4.5s), BEFORE
  // the dismissal cycle below toggles the state again.
  Timer {
    interval: 5500
    running: true
    repeat: false
    onTriggered: {
      console.log("JH-E2E-W2 " + JSON.stringify({
        popupOpen: widget.popupOpen
      }))
    }
  }

  // open:popupOpen binding intact. The original bug: the card assigned its
  // own open directly, the binding broke, and the chip went dead after the
  // first outside-click dismissal.
  Timer {
    interval: 7500
    running: true
    repeat: false
    onTriggered: {
      var card = widget.popupCard
      var sawOpen = false, closedCleanly = false, reopened = false
      if (card) {
        widget.openPopup()
        sawOpen = card.open === true
        card.close() // exactly what HyprlandFocusGrab.onCleared does
        closedCleanly = widget.popupOpen === false && card.open === false
        widget.openPopup() // the user pressing the chip again
        reopened = card.open === true
        widget.closePopup()
      }
      console.log("JH-E2E-W3 " + JSON.stringify({
        sawOpen: sawOpen, closedCleanly: closedCleanly, reopened: reopened
      }))
    }
  }

  Timer {
    interval: 9500
    running: true
    repeat: false
    onTriggered: Qt.quit()
  }
}
