import QtQuick
import Quickshell
import Quickshell.Io
import "." as Local

// Runtime E2E interaction harness: instantiates the real Panel against a
// degraded snapshot, then CLICKS its tabs and action buttons
// programmatically (signals are emittable in QML) and asserts the
// resulting POSTs. This closes the last unverified wiring link: button
// labels ↔ action handlers (a swapped ternary would make "Bring online"
// perform nodeOffline, and no other test would catch it). With the tabbed
// panel it also proves the tab bar routes to the right lists.
//
// The driver's server (port 28889) serves the degraded fixtures for GETs
// and logs POSTs. Clicks fire at 3.0/3.6/4.2s (tab first, then the
// button on that tab); the dump at 6.5s reflects the last action.

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
      enableCleanWorkspace: true,
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

  // Effective visibility: QML `visible` is local — a Button inside a
  // hidden ancestor still reports visible=true. Walk the parent chain.
  function effectivelyVisible(item) {
    var p = item
    while (p && p !== panel) {
      if (p.visible === false) return false
      p = p.parent
    }
    return true
  }

  // Clicks the first EFFECTIVELY VISIBLE button matching the text
  // exactly — a real user cannot click a hidden button, and hidden
  // matches (e.g. the workspace-preview Cancel while no preview is
  // open, or buttons on an inactive tab) would swallow clicks meant
  // for a visible same-named button elsewhere.
  function clickButtonByText(text) {
    var buttons = collectButtons(panel, [])
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].text === text && effectivelyVisible(buttons[i])) {
        buttons[i].clicked()
        return true
      }
    }
    console.log("JH-E2E-I-MISSING " + text + " (buttons seen: " + buttons.length + ")")
    return false
  }
  // Tab labels carry dynamic counts ("Nodes · 6"), so tabs are matched by
  // prefix while action buttons keep exact matching.
  function clickTab(prefix) {
    var buttons = collectButtons(panel, [])
    for (var i = 0; i < buttons.length; i++) {
      if (String(buttons[i].text).indexOf(prefix) === 0) {
        buttons[i].clicked()
        return true
      }
    }
    console.log("JH-E2E-I-MISSING ~" + prefix + " (buttons seen: " + buttons.length + ")")
    return false
  }

  Timer {
    // First poll lands ~1.5s; the degraded snapshot renders the tabs.
    interval: 3000
    running: true
    repeat: false
    onTriggered: {
      clickTab("Nodes")
      clickButtonByText("Bring online")   // agent-03 (offline in degraded)
      clickTimer.restart()
    }
  }

  // Collects every Text's content in the panel tree — used to prove the
  // Activity feed actually rendered rows from the extended tree data.
  function scanTexts(item, out) {
    for (var i = 0; i < item.children.length; i++) {
      var c = item.children[i]
      if (c.text !== undefined) out.push(String(c.text))
      if (c.children && c.children.length > 0) scanTexts(c, out)
    }
    return out
  }

  property var activityProbe: null
  property var tabHeights: ({ nodes: 0, queue: 0, overview: 0, jobs: 0, activity: 0 })

  Timer {
    id: clickTimer
    interval: 400
    repeat: true
    property int step: 0
    onTriggered: {
      step += 1
      // Heights are read at the START of each step, after the previous
      // tab's binding has settled (400ms), and keyed by that tab.
      if (step === 1) {
        tabHeights.nodes = Math.round(panel.implicitHeight)
        clickTab("Queue")
        clickButtonByText("Cancel")       // first queue item (id 201)
      } else if (step === 2) {
        tabHeights.queue = Math.round(panel.implicitHeight)
        clickTab("Overview")
        clickButtonByText("Quiet down")
      } else if (step === 3) {
        tabHeights.overview = Math.round(panel.implicitHeight)
        clickTab("Nodes")
        clickButtonByText("Clean ws")     // first online node: dry-run list
      } else if (step === 4) {
        clickButtonByText("Delete (2)")   // confirm: nodeWorkspaceClean
        clickTab("Jobs")
      } else if (step === 5) {
        tabHeights.jobs = Math.round(panel.implicitHeight)
        clickTab("Activity")
      } else if (step === 6) {
        tabHeights.activity = Math.round(panel.implicitHeight)
        var texts = scanTexts(panel, [])
        activityProbe = {
          tab: panel.activeTab,
          height: tabHeights.activity,
          sawBuilding: texts.some(function (t) { return t.indexOf(" so far") !== -1 }),
          sawRecent: texts.some(function (t) { return t.indexOf("#9") !== -1 })
        }
      } else {
        stop()
      }
    }
  }

  Timer {
    interval: 6500
    running: true
    repeat: false
    onTriggered: {
      console.log("JH-E2E-I " + JSON.stringify({
        actionMessage: service.actionMessage,
        state: service.state,
        queueDepth: service.snapshot ? service.snapshot.queue.depth : -1,
        activeTab: panel.activeTab,
        activityProbe: activityProbe,
        tabHeights: tabHeights
      }))
      Qt.quit()
    }
  }
}
