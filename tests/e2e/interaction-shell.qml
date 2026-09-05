import QtQuick
import Quickshell
import Quickshell.Io
import "." as Local

// Runtime E2E interaction harness: instantiates the real Panel against a
// degraded snapshot, then CLICKS its action buttons programmatically
// (signals are emittable in QML) and asserts the resulting POSTs. This
// closes the last unverified wiring link: button labels ↔ action handlers
// (a swapped ternary would make "Bring online" perform nodeOffline, and
// no existing test would catch it — labels are vision-checked, commands
// are action-phase-checked, but the connection between them is not).
//
// The driver's server (port 28889) serves the degraded fixtures for GETs
// and logs POSTs. Clicks fire at 3.0/3.6/4.2s; the dump at 6s reflects
// the last action's feedback.

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

  Local.Panel {
    id: panel
    width: 480
    height: 560
    service: service
    bar: fakeBarHost
  }

  Component.onCompleted: {
    service.applyConfig({
      jenkinsUrl: "http://127.0.0.1:28889",
      jenkinsUser: "e2e-user",
      tokenFile: Quickshell.env("JH_E2E_TOKEN_FILE") || "/tmp/jenkins-e2e/token",
      refreshIntervalSec: 30,
      queueBacklogThreshold: 10,
      diskWarnGb: 25,
      diskCriticalGb: 10,
      responseTimeWarnMs: 1000,
      notifyController: false,
      notifyNodes: false,
      notifyFailures: false,
      notifyQueue: false,
      notifyMaintenance: false
    })
  }

  // Recursive walk collecting everything that looks like a Button
  // (has both `text` and a `clicked` signal — Text has no `clicked`).
  function collectButtons(item, acc) {
    if (!item) return acc
    var kids = item.children
    if (kids) {
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i]
        if (k && k.text !== undefined && k.clicked !== undefined) acc.push(k)
        collectButtons(k, acc)
      }
    }
    if (item.contentItem) {
      var ci = item.contentItem
      if (ci.text !== undefined && ci.clicked !== undefined) acc.push(ci)
      collectButtons(ci, acc)
    }
    return acc
  }

  function clickButtonByText(text) {
    var buttons = collectButtons(panel, [])
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].text === text) {
        buttons[i].clicked()
        return true
      }
    }
    console.log("JH-E2E-I-MISSING " + text + " (buttons seen: " + buttons.length + ")")
    return false
  }

  Timer {
    // First poll lands ~1.5s; the degraded snapshot renders the buttons.
    interval: 3000
    running: true
    repeat: false
    onTriggered: {
      clickButtonByText("Bring online")   // agent-03 (offline in degraded)
      clickTimer.restart()
    }
  }

  Timer {
    id: clickTimer
    interval: 600
    repeat: true
    property int step: 0
    onTriggered: {
      step += 1
      if (step === 1) {
        clickButtonByText("Cancel")       // first queue item (id 201)
      } else if (step === 2) {
        clickButtonByText("Quiet down")
      } else {
        stop()
      }
    }
  }

  Timer {
    interval: 6000
    running: true
    repeat: false
    onTriggered: {
      console.log("JH-E2E-I " + JSON.stringify({
        actionMessage: service.actionMessage,
        state: service.state,
        queueDepth: service.snapshot ? service.snapshot.queue.depth : -1
      }))
      Qt.quit()
    }
  }
}
