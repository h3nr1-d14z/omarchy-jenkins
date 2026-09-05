import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import "." as Local

// Runtime E2E render harness: draws the REAL BarWidget chip and the REAL
// Panel content in a layer-shell window, against the real Service polling
// the mock. run.sh locates the surface via its namespace in
// `hyprctl layers -j` and captures exactly that geometry with grim, so the
// screenshot contains only this test surface — never the user's desktop.
//
// The window sits at the top-left with a small margin, reserves no screen
// space (exclusiveZone -1), and quits on its own after 15s; the driver
// kills it sooner.

PanelWindow {
  id: win

  WlrLayershell.namespace: "jh-e2e-render"
  anchors {
    top: true
    left: true
  }
  margins {
    top: 80
    left: 80
  }
  exclusiveZone: -1
  width: 480
  height: 620

  Service {
    id: service
  }

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
    property int barSize: 32
    property bool foregroundAnimationEnabled: true
    property var activePopout: null

    function showTooltip(item, text) {}
    function hideTooltip(item) {}
    function requestPopout(key) {}
    function releasePopout(key) {}
  }

  Rectangle {
    anchors.fill: parent
    color: "#16181d"
    radius: 10

    Column {
      anchors.fill: parent
      anchors.margins: 14
      spacing: 12

      BarWidget {
        id: widget
        bar: fakeBarHost
        width: parent.width
        height: 34

        settings: ({
          jenkinsUrl: "http://127.0.0.1:28888",
          jenkinsUser: "e2e-user",
          tokenFile: Quickshell.env("JH_E2E_TOKEN_FILE") || "/tmp/jenkins-e2e/token",
          refreshIntervalSec: 30,
          queueBacklogThreshold: 10,
          diskWarnGb: 25,
          diskCriticalGb: 10,
          responseTimeWarnMs: 1000
        })
      }

      Local.Panel {
        service: service
        bar: fakeBarHost
        width: parent.width
        height: parent.height - widget.height - parent.spacing
      }
    }
  }

  Timer {
    interval: 2500
    running: true
    repeat: false
    onTriggered: {
      console.log("JH-E2E-R " + JSON.stringify({
        state: service.state,
        score: service.score,
        widgetState: widget.state
      }))
    }
  }

  Timer {
    interval: 15000
    running: true
    repeat: false
    onTriggered: Qt.quit()
  }
}
