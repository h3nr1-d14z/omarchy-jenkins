import QtQuick
import Quickshell
import Quickshell.Io

// Runtime E2E harness: drives the real Service.qml against the mock Jenkins
// server on port 28888. run.sh generates a throwaway Quickshell config
// folder in /tmp (symlinking the real Service.qml/Model.js — Quickshell
// sandboxes configs to their own folder, and the plugin tree itself must
// stay symlink-free for the omarchy validator) and asserts on the dumped
// state.
//
// Environment knobs (all optional):
//   JH_E2E_TOKEN_FILE  token file path (default /tmp/jenkins-e2e/token)
//   JH_E2E_NOTIFY=1    enable all notification categories (default off, so
//                      tests never touch the desktop notification daemon)
//   JH_E2E_SHIM_DIR    injected as the service's omarchyPath: a fake omarchy
//                      tree whose bin/omarchy-notification-send logs its
//                      arguments, capturing every emitted notification
//   JH_E2E_QUIT_MS     dump-and-quit delay in ms (default 3000)
//   JH_E2E_REFRESH     refreshIntervalSec (default 30)

ShellRoot {
  id: app

  Service {
    id: service
  }

  Component.onCompleted: {
    var shimDir = Quickshell.env("JH_E2E_SHIM_DIR") || ""
    if (shimDir) service.omarchyPath = shimDir

    var notify = Quickshell.env("JH_E2E_NOTIFY") === "1"
    service.applyConfig({
      jenkinsUrl: "http://127.0.0.1:28888",
      jenkinsUser: "e2e-user",
      tokenFile: Quickshell.env("JH_E2E_TOKEN_FILE") || "/tmp/jenkins-e2e/token",
      refreshIntervalSec: parseInt(Quickshell.env("JH_E2E_REFRESH") || "30", 10),
      queueBacklogThreshold: 10,
      diskWarnGb: 25,
      diskCriticalGb: 10,
      responseTimeWarnMs: 1000,
      notifyController: notify,
      notifyNodes: notify,
      notifyFailures: notify,
      notifyQueue: notify,
      notifyMaintenance: notify
    })
  }

  Timer {
    // netrc write + five sequential curls against the local mock finish
    // well inside 3s; dump state and quit (JH_E2E_QUIT_MS overrides).
    interval: parseInt(Quickshell.env("JH_E2E_QUIT_MS") || "3000", 10)
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
