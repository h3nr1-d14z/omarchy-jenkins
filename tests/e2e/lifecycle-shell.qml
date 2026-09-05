import QtQuick
import Quickshell
import Quickshell.Io

// Runtime E2E lifecycle harness: proves the widget registry across its
// full lifecycle — static registration (first monitor), dynamic creation
// (the multi-monitor analog), the panel-open relay reaching ALL registered
// widgets, and unregister-on-destruction (Component.onDestruction).
//
// Timeline (asserted by run.sh):
//   t=1.5  L1: registry holds the static widget
//   t=2.0  create a second BarWidget dynamically
//   t=3.0  L2: registry holds both; relay opens both popups
//   t=4.0  destroy the dynamic widget
//   t=5.0  L3: registry dropped back to one; static widget unaffected

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

  // Both widgets push identical settings: applyConfig dedups, so the
  // dynamic widget must not disturb the running configuration.
  property var sharedSettings: ({
    jenkinsUrl: "http://127.0.0.1:28888",
    jenkinsUser: "e2e-user",
    tokenFile: Quickshell.env("JH_E2E_TOKEN_FILE") || "/tmp/jenkins-e2e/token",
    refreshIntervalSec: 30,
    queueBacklogThreshold: 10,
    diskWarnGb: 25,
    diskCriticalGb: 10,
    responseTimeWarnMs: 1000
  })

  property var dynamicWidget: null

  BarWidget {
    id: w1
    bar: fakeBarHost
    settings: root.sharedSettings
  }

  Timer {
    interval: 1500
    running: true
    repeat: false
    onTriggered: console.log("JH-E2E-L1 " + JSON.stringify({
      registered: service.widgets.length
    }))
  }

  Timer {
    interval: 2000
    running: true
    repeat: false
    onTriggered: {
      var comp = Qt.createComponent("BarWidget.qml")
      dynamicWidget = comp.createObject(root, {
        bar: fakeBarHost,
        settings: root.sharedSettings
      })
    }
  }

  Timer {
    interval: 3000
    running: true
    repeat: false
    onTriggered: {
      service.relayToWidgets("openPopup")
      console.log("JH-E2E-L2 " + JSON.stringify({
        registered: service.widgets.length,
        w1open: w1.popupOpen,
        w2open: dynamicWidget ? dynamicWidget.popupOpen : false
      }))
    }
  }

  Timer {
    interval: 4000
    running: true
    repeat: false
    onTriggered: if (dynamicWidget) dynamicWidget.destroy()
  }

  Timer {
    interval: 5000
    running: true
    repeat: false
    onTriggered: {
      console.log("JH-E2E-L3 " + JSON.stringify({
        registered: service.widgets.length,
        w1open: w1.popupOpen,
        serviceState: service.state
      }))
      Qt.quit()
    }
  }
}
