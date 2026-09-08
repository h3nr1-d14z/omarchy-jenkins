#!/usr/bin/env node
// Model.js contract tests for the jenkins-health plugin (70 checks).
//
// Model.js lives at the plugin root and is imported both by QML
// (`import "Model.js" as Model`) and here. For Node it must expose its
// top-level function declarations via CommonJS:
//
//   function parseController(...) { ... }
//   ...
//   if (typeof module !== "undefined" && module.exports) {
//     module.exports = { parseController, parseNodes, ... };
//   }
//
// Contract (all functions pure: they return fresh data, never mutate args):
//
//   parseController(apiJson, xJenkinsHeader) -> {
//     version: string            // header trimmed; "Unknown" when absent
//     mode: string, quietingDown: bool, useCrumbs: bool, useSecurity: bool,
//     numExecutors: number, jobs: [{name, color}]
//   }
//   parseNodes(computerJson) -> {
//     total: number, online: number, offline: number, temporarilyOffline: number,
//     nodes: [{displayName, offline, temporarilyOffline, offlineCauseReason,
//              diskBytes, tempBytes, responseTimeMs, architecture,
//              executorsTotal, executorsIdle}]
//   }
//   parseQueue(queueJson) -> { depth, stuck, items: [{id, name, why, inQueueSince, stuck}] }
//   parsePlugins(pluginManagerJson) -> { total, updatesAvailable,
//     plugins: [{shortName, version, hasUpdate, active, enabled, deprecated}] }
//   parseUpdateCenter(updateCenterJson) -> { restartRequired, jobs, warnings }
//
//   assess(controller, nodes, queue, plugins, updateCenter, config, now) -> {
//     controller: { status: "up"|"unreachable", level: "ok"|"warn"|"critical",
//                   healthScore: 0-100, reasons: [string],
//                   failures: number, unstable: number, building: number,
//                   quietingDown: bool },
//     nodes: [{displayName, state: "online"|"offline", diskGb, responseTimeMs,
//              level: "ok"|"warn"|"critical", reasons: [string]}],
//     queue: { depth, stuck, backlog: bool },
//     maintenance: { quietingDown, restartRequired, updatesAvailable },
//     overall: { level: "ok"|"warn"|"critical", score: 0-100, reasons: [string] }
//   }
//   // outage: controller=null (all parsed inputs null) -> status "unreachable",
//   // overall level "critical", score 0, reason "controller unreachable".
//   // healthy: overall "ok", score 95-100, no reasons (a single yellow job is
//   // tolerated silently). degraded: "warn", score 50-70, reasons mention
//   // disk / queue / failing jobs.
//
//   diffEvents(prevSnapshot, nextSnapshot, config) -> [{type, severity, message}]
//   // severity: "info"|"warn"|"error"|"critical"
//   // types: "controller-down", "controller-up", "node-offline", "node-online",
//   //        "job-failure", "job-recovered", "queue-backlog", "queue-clear",
//   //        "maintenance"
//   // config toggles: notifyController, notifyNodes, notifyFailures,
//   //                 notifyQueue, notifyMaintenance (booleans)
//   // prev=null (first poll) -> no events. Identical snapshots -> no events.
//
//   buildNetrc(user, token, jenkinsUrl) -> string
//   // "machine <host>\nlogin <user>\npassword <token>" (separate lines)
//
//   buildCurlArgs(endpoint, method, jenkinsUrl, netrcPath, crumb) -> array
//   // ["curl", "-fsS", "--max-time", "8", "--netrc-file", netrcPath,
//   //  "-H", "Accept: application/json", ...("-X", method), ...crumb header,
//   //  fullUrl]  — crumb: ["-H", "Jenkins-Crumb: <crumb>"], omitted when null
//
//   buildActionCommand(action, targetId, jenkinsUrl, netrcPath, crumb) -> array
//   // POST command for safe actions, e.g. {action:"cancelQueueItem",
//   // targetId:"123"} -> curl POST <base>/queue/cancelItem?id=123 with crumb
//
// Always exits 0: failures lower the score, they never break the harness.
// Prints one PASS/FAIL line per check and a final
// "model_passed=N model_failed=N model_total=70" summary.

import { test, after } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const MODEL_URL = new URL('../../Model.js', import.meta.url).href;
let M = null;
let importError = null;
try {
  const mod = await import(MODEL_URL);
  M = typeof mod.parseController === 'function' ? mod : (mod.default ?? null);
} catch (e) {
  importError = e;
}

if (importError || M === null) {
  const why = importError ? `import failed: ${importError.message}` : 'no exports found';
  console.log(`Model.js not found — 0/70 checks passed (${why})`);
  console.log('model_passed=0 model_failed=70 model_total=70');
  process.exit(0);
}

// ---------------------------------------------------------------- fixtures

const fx = (scenario, file) =>
  JSON.parse(readFileSync(new URL(`../fixtures/jenkins/${scenario}/${file}`, import.meta.url), 'utf8'));
const rawHeader = (scenario) =>
  readFileSync(new URL(`../fixtures/jenkins/${scenario}/x-jenkins-header.txt`, import.meta.url), 'utf8');

const NOW = 1704067200000; // 2024-01-01T00:00:00Z, frozen
const CONFIG = {
  jenkinsUrl: 'https://ci.example.com',
  jenkinsUser: 'alice',
  tokenFile: '~/.config/jenkins-health/token',
  refreshIntervalSec: 30,
  queueBacklogThreshold: 10,
  diskWarnGb: 25,
  diskCriticalGb: 10,
  responseTimeWarnMs: 1000,
  notifyController: true,
  notifyNodes: true,
  notifyFailures: true,
  notifyQueue: true,
  notifyMaintenance: true,
};
const off = (key) => ({ ...CONFIG, [key]: false });

const parseAll = (scenario) => ({
  controller: M.parseController(fx(scenario, 'api.json'), rawHeader(scenario)),
  nodes: M.parseNodes(fx(scenario, 'computer.json')),
  queue: M.parseQueue(fx(scenario, 'queue.json')),
  plugins: M.parsePlugins(fx(scenario, 'pluginManager.json')),
  updateCenter: M.parseUpdateCenter(fx(scenario, 'updateCenter.json')),
});

const snaps = {};
const snap = (name) => {
  if (!(name in snaps)) {
    snaps[name] =
      name === 'outage'
        ? M.assess(null, null, null, null, null, CONFIG, NOW)
        : M.assess(
            ...[
              'controller',
              'nodes',
              'queue',
              'plugins',
              'updateCenter',
            ].map((k) => parseAll(name)[k]),
            CONFIG,
            NOW,
          );
  }
  return snaps[name];
};

const diff = (prev, next, config = CONFIG) => M.diffEvents(prev, next, config);
const hasType = (events, type) => events.some((e) => e.type === type);
const hasPair = (arr, a, b) => arr.some((v, i) => v === a && arr[i + 1] === b);
const reasonText = (s) => [...(s.overall?.reasons ?? [])].join(' | ');
const makeQueueJson = (n) => ({
  items: Array.from({ length: n }, (_, i) => ({
    id: 900 + i,
    task: { name: `job-${i}` },
    why: 'Waiting for next available executor',
    inQueueSince: NOW - 120000,
    stuck: false,
  })),
});
const boundaryAssess = (n) =>
  M.assess(
    parseAll('healthy').controller,
    parseAll('healthy').nodes,
    M.parseQueue(makeQueueJson(n)),
    parseAll('healthy').plugins,
    parseAll('healthy').updateCenter,
    CONFIG,
    NOW,
  );

// --------------------------------------------------------------- counters

let passed = 0;
let failed = 0;
function check(name, fn) {
  test(name, () => {
    try {
      fn();
      passed += 1;
      console.log(`PASS: ${name}`);
    } catch (e) {
      failed += 1;
      console.log(`FAIL: ${name} — ${e && e.message ? e.message : e}`);
    }
  });
}

// ================================================================ parsing

check('parseController: version from X-Jenkins header (trailing newline trimmed)', () => {
  const r = M.parseController(fx('healthy', 'api.json'), rawHeader('healthy'));
  assert.equal(r.version, '2.440.3');
});

check('parseController: mode and quietingDown', () => {
  const r = M.parseController(fx('healthy', 'api.json'), '2.440.3');
  assert.equal(r.mode, 'NORMAL');
  assert.equal(r.quietingDown, false);
});

check('parseController: jobs extracted with names and colors, input not mutated', () => {
  const api = fx('healthy', 'api.json');
  const before = structuredClone(api);
  const r = M.parseController(api, '2.440.3');
  assert.equal(r.jobs.length, 8);
  assert.equal(r.jobs[0].name, 'checkout-service');
  assert.equal(r.jobs[0].color, 'blue');
  assert.deepEqual(api, before);
});

check('parseController: null input yields sane defaults, no crash', () => {
  const r = M.parseController(null, null);
  assert.equal(r.version, 'Unknown');
  assert.deepEqual(r.jobs, []);
  assert.equal(r.quietingDown, false);
});

check('parseController: malformed object yields sane defaults, no crash', () => {
  const r = M.parseController({ malformed: true }, undefined);
  assert.equal(r.version, 'Unknown');
  assert.deepEqual(r.jobs, []);
});

check('parseNodes: healthy totals (6 nodes, all online)', () => {
  const r = M.parseNodes(fx('healthy', 'computer.json'));
  assert.equal(r.total, 6);
  assert.equal(r.online, 6);
  assert.equal(r.offline, 0);
});

check('parseNodes: healthy executors (30 idle of 30)', () => {
  const r = M.parseNodes(fx('healthy', 'computer.json'));
  assert.equal(r.nodes.reduce((s, n) => s + n.executorsTotal, 0), 30);
  assert.equal(r.nodes.reduce((s, n) => s + n.executorsIdle, 0), 30);
});

check('parseNodes: degraded has one offline node with cause', () => {
  const r = M.parseNodes(fx('degraded', 'computer.json'));
  assert.equal(r.offline, 1);
  const node = r.nodes.find((n) => n.displayName === 'build-agent-03');
  assert.ok(node && node.offline === true);
  assert.match(node.offlineCauseReason, /disk/i);
});

check('parseNodes: offline node disk bytes preserved', () => {
  const r = M.parseNodes(fx('degraded', 'computer.json'));
  const node = r.nodes.find((n) => n.displayName === 'build-agent-03');
  assert.equal(node.diskBytes, 9000000000);
  assert.equal(node.responseTimeMs, 3200);
});

check('parseNodes: null input yields empty node set, no crash', () => {
  const r = M.parseNodes(null);
  assert.equal(r.total, 0);
  assert.deepEqual(r.nodes, []);
});

check('parseQueue: healthy depth 2, nothing stuck', () => {
  const r = M.parseQueue(fx('healthy', 'queue.json'));
  assert.equal(r.depth, 2);
  assert.equal(r.stuck, 0);
});

check('parseQueue: degraded depth 12 with 1 stuck', () => {
  const r = M.parseQueue(fx('degraded', 'queue.json'));
  assert.equal(r.depth, 12);
  assert.equal(r.stuck, 1);
});

check('parseQueue: null input yields empty queue, no crash', () => {
  const r = M.parseQueue(null);
  assert.equal(r.depth, 0);
  assert.equal(r.stuck, 0);
  assert.deepEqual(r.items, []);
});

check('parsePlugins: update counts (healthy 0, degraded 3)', () => {
  assert.equal(M.parsePlugins(fx('healthy', 'pluginManager.json')).updatesAvailable, 0);
  assert.equal(M.parsePlugins(fx('degraded', 'pluginManager.json')).updatesAvailable, 3);
});

check('parseUpdateCenter: restartRequired (healthy false, degraded true)', () => {
  assert.equal(M.parseUpdateCenter(fx('healthy', 'updateCenter.json')).restartRequired, false);
  assert.equal(M.parseUpdateCenter(fx('degraded', 'updateCenter.json')).restartRequired, true);
});

// ============================================================= assessment

check('assess healthy: overall level ok with no reasons', () => {
  const s = snap('healthy');
  assert.equal(s.overall.level, 'ok');
  assert.deepEqual(s.overall.reasons, []);
});

check('assess healthy: overall and controller health scores in 95-100', () => {
  const s = snap('healthy');
  assert.ok(s.overall.score >= 95 && s.overall.score <= 100, `overall.score=${s.overall.score}`);
  assert.ok(
    s.controller.healthScore >= 95 && s.controller.healthScore <= 100,
    `controller.healthScore=${s.controller.healthScore}`,
  );
});

check('assess healthy: controller up and ok', () => {
  const s = snap('healthy');
  assert.equal(s.controller.status, 'up');
  assert.equal(s.controller.level, 'ok');
});

check('assess degraded: overall level warn', () => {
  assert.equal(snap('degraded').overall.level, 'warn');
});

check('assess degraded: overall score 50-70', () => {
  const score = snap('degraded').overall.score;
  assert.ok(score >= 50 && score <= 70, `overall.score=${score}`);
});

check('assess degraded: a reason mentions disk', () => {
  assert.match(reasonText(snap('degraded')), /disk/i);
});

check('assess degraded: a reason mentions the queue', () => {
  assert.match(reasonText(snap('degraded')), /queue/i);
});

check('assess degraded: a reason mentions failing jobs', () => {
  assert.match(reasonText(snap('degraded')), /fail|red/i);
});

check('assess outage: overall level critical and score 0', () => {
  const s = snap('outage');
  assert.equal(s.overall.level, 'critical');
  assert.equal(s.overall.score, 0);
});

check('assess outage: controller unreachable with matching reason', () => {
  const s = snap('outage');
  assert.equal(s.controller.status, 'unreachable');
  assert.ok(s.overall.reasons.some((r) => /controller unreachable/i.test(r)), JSON.stringify(s.overall.reasons));
});

check('assess healthy: all nodes online and ok', () => {
  const nodes = snap('healthy').nodes;
  assert.equal(nodes.length, 6);
  assert.ok(nodes.every((n) => n.state === 'online' && n.level === 'ok'));
});

check('assess degraded: exactly one node offline', () => {
  const offline = snap('degraded').nodes.filter((n) => n.state === 'offline');
  assert.equal(offline.length, 1);
});

check('assess degraded: build-agent-03 critical with a disk reason', () => {
  const node = snap('degraded').nodes.find((n) => n.displayName === 'build-agent-03');
  assert.equal(node.level, 'critical');
  assert.ok(node.reasons.some((r) => /disk/i.test(r)), JSON.stringify(node.reasons));
});

check('assess degraded: build-agent-02 warn with 1200ms response time', () => {
  const node = snap('degraded').nodes.find((n) => n.displayName === 'build-agent-02');
  assert.equal(node.level, 'warn');
  assert.equal(node.responseTimeMs, 1200);
});

check('assess queue boundary: depth at threshold (10) is no backlog', () => {
  assert.equal(boundaryAssess(10).queue.backlog, false);
});

check('assess queue boundary: depth above threshold (11) is backlog', () => {
  assert.equal(boundaryAssess(11).queue.backlog, true);
});

check('assess degraded: ball colors (2 red, 1 yellow, 1 building)', () => {
  const c = snap('degraded').controller;
  assert.equal(c.failures, 2);
  assert.equal(c.unstable, 1);
  assert.equal(c.building, 1);
});

check('assess maintenance state (healthy 0 updates/no restart, degraded 3/restart)', () => {
  assert.equal(snap('healthy').maintenance.updatesAvailable, 0);
  assert.equal(snap('healthy').maintenance.restartRequired, false);
  assert.equal(snap('degraded').maintenance.updatesAvailable, 3);
  assert.equal(snap('degraded').maintenance.restartRequired, true);
});

check('assess degraded: queue depth 12, stuck 1, backlog true', () => {
  const q = snap('degraded').queue;
  assert.equal(q.depth, 12);
  assert.equal(q.stuck, 1);
  assert.equal(q.backlog, true);
});

check('assess healthy: parsed inputs not mutated', () => {
  const parsed = parseAll('healthy');
  const before = structuredClone(parsed);
  M.assess(
    parsed.controller,
    parsed.nodes,
    parsed.queue,
    parsed.plugins,
    parsed.updateCenter,
    CONFIG,
    NOW,
  );
  assert.deepEqual(parsed, before);
});

// ============================================================ event diffing

check('diffEvents: identical snapshots emit no events, inputs not mutated', () => {
  const prev = snap('healthy');
  const before = structuredClone(prev);
  const events = diff(prev, snap('healthy'));
  assert.deepEqual(events, []);
  assert.deepEqual(prev, before);
});

check('diffEvents: healthy->degraded emits events', () => {
  assert.ok(diff(snap('healthy'), snap('degraded')).length > 0);
});

check('diffEvents: healthy->degraded includes node-offline', () => {
  assert.ok(hasType(diff(snap('healthy'), snap('degraded')), 'node-offline'));
});

check('diffEvents: healthy->degraded includes job-failure', () => {
  assert.ok(hasType(diff(snap('healthy'), snap('degraded')), 'job-failure'));
});

check('diffEvents: healthy->degraded includes queue-backlog', () => {
  assert.ok(hasType(diff(snap('healthy'), snap('degraded')), 'queue-backlog'));
});

check('diffEvents: healthy->degraded includes maintenance (restart required)', () => {
  assert.ok(hasType(diff(snap('healthy'), snap('degraded')), 'maintenance'));
});

check('diffEvents: degraded->healthy includes node-online recovery', () => {
  assert.ok(hasType(diff(snap('degraded'), snap('healthy')), 'node-online'));
});

check('diffEvents: degraded->healthy includes job-recovered', () => {
  assert.ok(hasType(diff(snap('degraded'), snap('healthy')), 'job-recovered'));
});

check('diffEvents: degraded->healthy includes queue-clear', () => {
  assert.ok(hasType(diff(snap('degraded'), snap('healthy')), 'queue-clear'));
});

check('diffEvents: healthy->outage includes controller-down', () => {
  assert.ok(hasType(diff(snap('healthy'), snap('outage')), 'controller-down'));
});

check('diffEvents: healthy->outage controller-down severity critical', () => {
  const e = diff(snap('healthy'), snap('outage')).find((x) => x.type === 'controller-down');
  assert.ok(e, 'no controller-down event');
  assert.equal(e.severity, 'critical');
});

check('diffEvents: outage->healthy includes controller-up', () => {
  assert.ok(hasType(diff(snap('outage'), snap('healthy')), 'controller-up'));
});

check('diffEvents: outage->healthy controller-up severity info', () => {
  const e = diff(snap('outage'), snap('healthy')).find((x) => x.type === 'controller-up');
  assert.ok(e, 'no controller-up event');
  assert.equal(e.severity, 'info');
});

check('diffEvents: every event has a valid type, severity, and message', () => {
  const transitions = [
    [snap('healthy'), snap('degraded')],
    [snap('degraded'), snap('healthy')],
    [snap('healthy'), snap('outage')],
    [snap('outage'), snap('healthy')],
  ];
  const severities = new Set(['info', 'warn', 'error', 'critical']);
  for (const [prev, next] of transitions) {
    for (const e of diff(prev, next)) {
      assert.equal(typeof e.type, 'string', `event type not a string: ${JSON.stringify(e)}`);
      assert.ok(e.type.length > 0, 'empty event type');
      assert.ok(severities.has(e.severity), `bad severity: ${JSON.stringify(e)}`);
      assert.equal(typeof e.message, 'string', 'message not a string');
      assert.ok(e.message.trim().length > 0, 'empty message');
    }
  }
});

check('diffEvents: healthy->degraded emits no controller-down/up (controller stayed up)', () => {
  const events = diff(snap('healthy'), snap('degraded'));
  assert.ok(!hasType(events, 'controller-down'));
  assert.ok(!hasType(events, 'controller-up'));
});

check('diffEvents: notifyController off suppresses controller-down', () => {
  const events = diff(snap('healthy'), snap('outage'), off('notifyController'));
  assert.ok(!hasType(events, 'controller-down'));
});

check('diffEvents: notifyController off suppresses controller-up', () => {
  const events = diff(snap('outage'), snap('healthy'), off('notifyController'));
  assert.ok(!hasType(events, 'controller-up'));
});

check('diffEvents: notifyNodes off suppresses node events', () => {
  const events = diff(snap('healthy'), snap('degraded'), off('notifyNodes'));
  assert.ok(!hasType(events, 'node-offline'));
  assert.ok(!hasType(events, 'node-online'));
});

check('diffEvents: notifyFailures off suppresses job events', () => {
  const events = diff(snap('healthy'), snap('degraded'), off('notifyFailures'));
  assert.ok(!hasType(events, 'job-failure'));
  assert.ok(!hasType(events, 'job-recovered'));
});

check('diffEvents: notifyQueue off suppresses queue events', () => {
  const events = diff(snap('healthy'), snap('degraded'), off('notifyQueue'));
  assert.ok(!hasType(events, 'queue-backlog'));
  assert.ok(!hasType(events, 'queue-clear'));
});

check('diffEvents: notifyMaintenance off suppresses maintenance events', () => {
  const events = diff(snap('healthy'), snap('degraded'), off('notifyMaintenance'));
  assert.ok(!hasType(events, 'maintenance'));
});

check('diffEvents: quietingDown false->true emits maintenance', () => {
  const next = structuredClone(snap('healthy'));
  next.controller.quietingDown = true;
  next.maintenance.quietingDown = true;
  assert.ok(hasType(diff(snap('healthy'), next), 'maintenance'));
});

check('diffEvents: no token-like secrets in any message', () => {
  const transitions = [
    [snap('healthy'), snap('degraded')],
    [snap('degraded'), snap('healthy')],
    [snap('healthy'), snap('outage')],
    [snap('outage'), snap('healthy')],
  ];
  for (const [prev, next] of transitions) {
    for (const e of diff(prev, next)) {
      assert.doesNotMatch(e.message, /sqa_|sqp_|[0-9a-fA-F]{40}/, `secret-looking message: ${e.message}`);
    }
  }
});

check('diffEvents: null previous snapshot (first poll) emits no events', () => {
  assert.deepEqual(diff(null, snap('healthy')), []);
});

check('diffEvents: degraded->healthy recovery events are severity info', () => {
  const events = diff(snap('degraded'), snap('healthy'));
  for (const type of ['node-online', 'job-recovered', 'queue-clear']) {
    const e = events.find((x) => x.type === type);
    assert.ok(e, `missing ${type}`);
    assert.equal(e.severity, 'info');
  }
});

// ========================================================= command builders

check('buildNetrc: machine line for the Jenkins host', () => {
  const lines = M.buildNetrc('alice', 'tok-abc123', 'https://ci.example.com').split('\n').map((l) => l.trim());
  assert.ok(lines.includes('machine ci.example.com'), JSON.stringify(lines));
});

check('buildNetrc: login line with the user', () => {
  const lines = M.buildNetrc('alice', 'tok-abc123', 'https://ci.example.com').split('\n').map((l) => l.trim());
  assert.ok(lines.includes('login alice'), JSON.stringify(lines));
});

check('buildNetrc: password line with the token', () => {
  const lines = M.buildNetrc('alice', 'tok-abc123', 'https://ci.example.com').split('\n').map((l) => l.trim());
  assert.ok(lines.includes('password tok-abc123'), JSON.stringify(lines));
});

check('buildCurlArgs: byte-cap wrap + core flags (curl, -fsS, --max-time 8)', () => {
  const args = M.buildCurlArgs('/api/json', 'GET', 'https://ci.example.com', '/tmp/netrc', null);
  assert.ok(Array.isArray(args), 'not an array');
  assert.equal(args[0], 'bash');
  assert.equal(args[1], '-c');
  assert.ok(args[2].includes('set -o pipefail'), 'no pipefail');
  assert.ok(args[2].includes('head -c ' + M.maxResponseBytes), 'no head cap');
  assert.equal(args[3], 'jh-curl');
  assert.equal(args[4], 'curl');
  assert.equal(args[5], '-fsS');
  assert.ok(hasPair(args, '--max-time', '8'), JSON.stringify(args));
  assert.ok(hasPair(args, '--max-filesize', String(M.maxResponseBytes)), JSON.stringify(args));
});

check('buildCurlArgs: --netrc-file points at the netrc path', () => {
  const args = M.buildCurlArgs('/api/json', 'GET', 'https://ci.example.com', '/tmp/netrc', null);
  assert.ok(hasPair(args, '--netrc-file', '/tmp/netrc'), JSON.stringify(args));
});

check('buildCurlArgs: Accept header and joined URL', () => {
  const args = M.buildCurlArgs('/api/json', 'GET', 'https://ci.example.com', '/tmp/netrc', null);
  assert.ok(hasPair(args, '-H', 'Accept: application/json'), JSON.stringify(args));
  assert.ok(args.includes('https://ci.example.com/api/json'), JSON.stringify(args));
});

check('buildCurlArgs: POST method flag', () => {
  const args = M.buildCurlArgs('/quietDown', 'POST', 'https://ci.example.com', '/tmp/netrc', 'crumb-1');
  assert.ok(hasPair(args, '-X', 'POST'), JSON.stringify(args));
});

check('buildCurlArgs: crumb header when present, absent when null', () => {
  const withCrumb = M.buildCurlArgs('/api/json', 'GET', 'https://ci.example.com', '/tmp/netrc', 'crumb-1');
  assert.ok(hasPair(withCrumb, '-H', 'Jenkins-Crumb: crumb-1'), JSON.stringify(withCrumb));
  const noCrumb = M.buildCurlArgs('/api/json', 'GET', 'https://ci.example.com', '/tmp/netrc', null);
  assert.ok(!noCrumb.some((v) => String(v).includes('Jenkins-Crumb')), JSON.stringify(noCrumb));
});

check('buildActionCommand: cancelQueueItem is a POST with crumb and queue URL', () => {
  const args = M.buildActionCommand(
    { action: 'cancelQueueItem', targetId: '123' },
    null,
    'https://ci.example.com',
    '/tmp/netrc',
    'crumb-1',
  );
  assert.ok(Array.isArray(args), 'not an array');
  assert.ok(hasPair(args, '-X', 'POST'), JSON.stringify(args));
  assert.ok(args.some((v) => String(v).includes('Jenkins-Crumb: crumb-1')), JSON.stringify(args));
  assert.ok(
    args.some((v) => typeof v === 'string' && /queue\/cancelItem\?id=123$/.test(v)),
    JSON.stringify(args),
  );
});

check('buildActionCommand: trailing-slash base URL joins without double slash', () => {
  const args = M.buildActionCommand(
    { action: 'cancelQueueItem', targetId: '5' },
    null,
    'https://ci.example.com/',
    '/tmp/netrc',
    null,
  );
  const url = args.find((v) => typeof v === 'string' && /^https?:\/\//.test(v));
  assert.ok(url, JSON.stringify(args));
  assert.equal(url, 'https://ci.example.com/queue/cancelItem?id=5');
});

// ------------------------------------------------------------------ summary

after(() => {
  console.log(`model_passed=${passed} model_failed=${failed} model_total=70`);
});
