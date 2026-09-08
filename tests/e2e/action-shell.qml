import QtQuick
import Quickshell
import Quickshell.Io

// Runtime E2E action harness: points the real Service at the driver's
// inline action server (port 28889), which serves the crumb endpoint and
// accepts safe-action POSTs, logging method, path, and the crumb header.
// Proves the full action path at runtime:
//   runAction → crumb fetch → buildActionCommand → POST execution →
//   actionMessage feedback (success and failure), which must survive the
//   auto-refresh poll.
//
// JH_E2E_ACTIONS drives the action sequence (comma-separated, optional
// :targetId suffix). The first action fires at t=2s (after netrc and the
// first poll), then 600ms apart; the dump at 5.2s reflects the LAST
// action's feedback. The server's behavior (which endpoints succeed,
// whether the crumb endpoint exists) is driver-side.

ShellRoot {
  id: app

  Service {
    id: service
  }

  property var actionList: []
  property int actionIndex: 0

  Component.onCompleted: {
    var raw = String(Quickshell.env("JH_E2E_ACTIONS") || "quietDown,cancelQueueItem:207,nodeOffline:build-agent-03,nodeWorkspaceList:build-agent-03,nodeWorkspaceClean:build-agent-03,cancelQuietDown")
    var list = []
    var parts = raw.split(",")
    for (var i = 0; i < parts.length; i++) {
      var bits = parts[i].split(":")
      list.push({ action: bits[0], targetId: bits.length > 1 ? bits[1] : null })
    }
    actionList = list

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
    // Bootstrap: the first action fires at t=2s, then hands over to the
    // 600ms repeating timer for the rest of the sequence.
    interval: 2000
    running: true
    repeat: false
    onTriggered: {
      if (actionList.length > 0) {
        actionIndex = 1
        service.runAction(actionList[0].action, actionList[0].targetId)
      }
      actionTimer.restart()
    }
  }

  Timer {
    id: actionTimer
    interval: 600
    repeat: true
    onTriggered: {
      if (actionIndex >= actionList.length) {
        stop()
        return
      }
      var item = actionList[actionIndex]
      actionIndex += 1
      service.runAction(item.action, item.targetId)
    }
  }

  Timer {
    // 6 actions fire at 2.0s then every 0.6s (last at 5.0s); each chain
    // (crumb + POST) takes ~0.1s locally, so the last action's feedback —
    // success or failure — is stable well before this dump.
    interval: 7200
    running: true
    repeat: false
    onTriggered: {
      console.log("JH-E2E-A " + JSON.stringify({
        actionMessage: service.actionMessage,
        state: service.state,
        workspacePreview: service.workspacePreview
      }))
      Qt.quit()
    }
  }
}
