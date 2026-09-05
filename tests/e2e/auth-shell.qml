import QtQuick
import Quickshell
import Quickshell.Io

// Runtime E2E auth-failure harness: points the real Service at the
// driver's inline auth server (port 28890, which replies to /api/json
// with a configured HTTP status), or at a nonexistent token file. Proves
// the failure-classification branches execute in place in the live
// service: 401/403 → noauth (credentials message, prevSnapshot
// re-baselined), 3xx → unconfigured (URL scheme hint), and a missing
// token file → noauth (netrc path).

ShellRoot {
  id: app

  Service {
    id: service
  }

  Component.onCompleted: {
    service.applyConfig({
      jenkinsUrl: "http://127.0.0.1:28890",
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
    interval: 4000
    running: true
    repeat: false
    onTriggered: {
      var snap = service.snapshot
      console.log("JH-E2E-X " + JSON.stringify({
        state: service.state,
        statusMessage: service.statusMessage,
        controllerStatus: snap && snap.controller ? snap.controller.status : ""
      }))
      Qt.quit()
    }
  }
}
