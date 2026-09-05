import QtQuick
import Quickshell
import Quickshell.Io

// Runtime E2E harness: drives the real Service.qml against the mock Jenkins
// server on port 28888. run.sh generates a throwaway Quickshell config
// folder in /tmp (symlinking the real Service.qml/Model.js — Quickshell
// sandboxes configs to their own folder, and the plugin tree itself must
// stay symlink-free for the omarchy validator) and asserts on the dumped
// state. Notifications are disabled so the test never touches the desktop
// notification daemon.

ShellRoot {
  id: app

  Service {
    id: service
  }

  Component.onCompleted: {
    service.applyConfig({
      jenkinsUrl: "http://127.0.0.1:28888",
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
    // netrc write + five sequential curls against the local mock finish
    // well inside 3s; dump state and quit.
    interval: 3000
    running: true
    repeat: false
    onTriggered: {
      var snap = service.snapshot
      console.log("JH-E2E " + JSON.stringify({
        state: service.state,
        level: service.level,
        score: service.score,
        version: service.version,
        controllerStatus: service.controllerStatus,
        nodes: snap && snap.nodes ? snap.nodes.length : -1,
        queueDepth: snap && snap.queue ? snap.queue.depth : -1,
        statusMessage: service.statusMessage
      }))
      Qt.quit()
    }
  }
}
