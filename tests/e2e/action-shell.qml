import QtQuick
import Quickshell
import Quickshell.Io

// Runtime E2E action harness: points the real Service at the driver's
// inline action server (port 28889), which serves the crumb endpoint and
// accepts safe-action POSTs, logging method, path, and the crumb header.
// Proves the full action path at runtime:
//   runAction → crumb fetch → buildActionCommand → POST execution →
//   actionMessage feedback (which must survive the auto-refresh poll).

ShellRoot {
  id: app

  Service {
    id: service
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
  Timer {
    // Netrc completes ~0.5s in; the first poll fails against the action
    // server (404 /api/json → outage state), which is fine — runAction
    // only needs jenkinsUrl and netrcOk. Three spaced actions cover the
    // three command shapes: bare endpoint, query-string targetId, and the
    // computer path.
    interval: 2000
    running: true
    repeat: false
    onTriggered: service.runAction("quietDown", null)
  }

  Timer {
    interval: 2600
    running: true
    repeat: false
    onTriggered: service.runAction("cancelQueueItem", 207)
  }

  Timer {
    interval: 3200
    running: true
    repeat: false
    onTriggered: service.runAction("nodeOffline", "build-agent-03")
  }

  Timer {
    // The action's auto-refresh poll fires ~1.2s after the POST; dumping
    // at 4s proves the feedback survives it.
    interval: 4000
    running: true
    repeat: false
    onTriggered: {
      console.log("JH-E2E-A " + JSON.stringify({
        actionMessage: service.actionMessage,
        state: service.state
      }))
      Qt.quit()
    }
  }
}
