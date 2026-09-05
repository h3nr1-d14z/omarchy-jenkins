import QtQuick
import Quickshell
import Quickshell.Io
import "." as Local

// Runtime E2E first-run harness: the widget starts with EMPTY settings —
// the state a user sees before configuring anything — then receives a
// settings change at runtime (as omarchy does when shell.json is edited),
// using a TILDE-path token file like the manifest default. Proves:
//   1. unconfigured: service state, "setup" chip, the guidance message
//   2. runtime reconfiguration: settings change → applyConfig → netrc → poll
//   3. tilde paths: QML expandTilde and the bash script's own expansion
//      agree, and the netrc lands next to the token file
//
// Timeline: U1 dump at 2.5s (unconfigured), settings change at 3s,
// U2 dump at 8s (healthy via the mock), quit.

ShellRoot {
  id: root

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

  BarWidget {
    id: widget
    bar: fakeBarHost
    settings: ({})
  }

  Timer {
    interval: 2500
    running: true
    repeat: false
    onTriggered: {
      console.log("JH-E2E-U1 " + JSON.stringify({
        state: service.state,
        chipText: widget.chipText,
        statusMessage: service.statusMessage
      }))
    }
  }

  Timer {
    interval: 3000
    running: true
    repeat: false
    onTriggered: {
      // Runtime settings change — the same path omarchy drives when the
      // user edits shell.json. Tilde path like the manifest default.
      widget.settings = ({
        jenkinsUrl: "http://127.0.0.1:28888",
        jenkinsUser: "e2e-user",
        tokenFile: "~/.jh-e2e-test/token",
        refreshIntervalSec: 30,
        queueBacklogThreshold: 10,
        diskWarnGb: 25,
        diskCriticalGb: 10,
        responseTimeWarnMs: 1000
      })
    }
  }

  Timer {
    interval: 8000
    running: true
    repeat: false
    onTriggered: {
      console.log("JH-E2E-U2 " + JSON.stringify({
        state: service.state,
        score: service.score,
        chipText: widget.chipText,
        version: service.version
      }))
      Qt.quit()
    }
  }
}
