#!/usr/bin/env node
// Property-based invariant sweep for Model.js (plugin-owned dev test).
//
// Unlike the frozen benchmark harness (fixed healthy/degraded/outage
// fixtures), this generates hundreds of randomized Jenkins-like inputs —
// including malformed and degenerate ones — and asserts structural
// invariants that must hold for ANY input. Deterministic seed: failures
// are reproducible. Run: node tests/model_properties.mjs

import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const mod = await import(fileURLToPath(new URL('../Model.js', import.meta.url)));
const Model = mod.parseController ? mod : mod.default;

// ------------------------------------------------------------ PRNG + helpers

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 20260905;
const rand = mulberry32(SEED);
const ri = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const chance = (p) => rand() < p;

const LEVELS = new Set(['ok', 'warn', 'critical']);
const SEVERITIES = new Set(['info', 'warn', 'error', 'critical']);
const SECRET_RE = /sqa_|sqp_|[0-9a-fA-F]{40}/;
const EVENT_TYPES = new Set([
  'controller-down', 'controller-up', 'node-offline', 'node-online',
  'job-failure', 'job-recovered', 'queue-backlog', 'queue-clear', 'maintenance',
]);

// ------------------------------------------------------------ input generators

const COLORS = [
  'blue', 'blue', 'blue', 'blue', // healthy jobs dominate real controllers
  'blue_anime', 'yellow', 'yellow', 'red', 'red_anime', 'disabled', 'aborted', 'notbuilt',
];

function genApi() {
  if (chance(0.08)) return chance(0.5) ? null : {}; // malformed
  const jobs = [];
  const n = ri(0, 25);
  for (let i = 0; i < n; i++) {
    jobs.push({ name: 'job-' + i, color: pick(COLORS) });
  }
  const api = {
    mode: pick(['NORMAL', 'NORMAL', 'EXCLUSIVE']),
    quietingDown: chance(0.1),
    useCrumbs: chance(0.9),
    useSecurity: chance(0.9),
    numExecutors: ri(0, 10),
    jobs,
  };
  if (chance(0.05)) delete api.jobs;
  if (chance(0.05)) api.jobs = null;
  return api;
}

function genNode(i) {
  const offline = chance(0.15);
  const tempOffline = !offline && chance(0.05);
  const diskGb = pick([3, 9, 20, 30, 60, 120, 250, 500]);
  const node = {
    displayName: 'node-' + i,
    offline,
    temporarilyOffline: tempOffline,
    offlineCauseReason: offline ? pick(['Disk space is too low', 'Connection was broken', '']) : '',
    monitorData: {
      'hudson.node_monitors.DiskSpaceMonitor': { path: '/', size: diskGb * 1e9 },
      'hudson.node_monitors.TemporarySpaceMonitor': { path: '/tmp', size: ri(5, 100) * 1e9 },
      'hudson.node_monitors.ResponseTimeMonitor': { average: pick([20, 60, 150, 700, 1200, 5000]) },
      'hudson.node_monitors.ArchitectureMonitor': 'Linux (amd64)',
    },
    executors: Array.from({ length: ri(0, 8) }, () => ({ idle: chance(0.7) })),
    oneOffExecutors: [],
  };
  if (chance(0.05)) delete node.monitorData;
  if (chance(0.05)) node.monitorData = null;
  if (chance(0.05)) node.executors = null;
  return node;
}

function genComputer() {
  if (chance(0.08)) return chance(0.5) ? null : { malformed: true };
  return { computer: Array.from({ length: ri(0, 12) }, (_, i) => genNode(i)) };
}

function genQueue(now) {
  if (chance(0.08)) return chance(0.5) ? null : [];
  const items = Array.from({ length: ri(0, 40) }, (_, i) => ({
    id: 100 + i,
    task: { name: 'queued-' + i },
    why: pick(['Waiting for next available executor', '']),
    inQueueSince: now - ri(0, 3600) * 1000,
    stuck: chance(0.15),
  }));
  return { items };
}

function genPlugins() {
  if (chance(0.08)) return null;
  return {
    plugins: Array.from({ length: ri(0, 40) }, (_, i) => ({
      shortName: 'plugin-' + i,
      version: '1.' + ri(0, 99),
      hasUpdate: chance(0.2),
      active: chance(0.95),
      enabled: chance(0.95),
      deprecated: chance(0.05),
    })),
  };
}

function genUc() {
  if (chance(0.08)) return null;
  return { restartRequiredForCompletion: chance(0.2), jobs: [], warnings: [] };
}

function genConfig() {
  const diskCriticalGb = ri(1, 20);
  return {
    jenkinsUrl: 'https://ci.example.com',
    jenkinsUser: 'u',
    tokenFile: '~/.config/jenkins-health/token',
    refreshIntervalSec: 30,
    queueBacklogThreshold: ri(1, 30),
    diskWarnGb: diskCriticalGb + ri(0, 40),
    diskCriticalGb,
    responseTimeWarnMs: pick([100, 500, 1000, 2000]),
    notifyController: chance(0.8),
    notifyNodes: chance(0.8),
    notifyFailures: chance(0.8),
    notifyQueue: chance(0.8),
    notifyMaintenance: chance(0.8),
  };
}

// ---------------------------------------------------------------- invariants

const NOW = 1704067200000;
let checks = 0;
function ok(cond, label, detail) {
  checks += 1;
  if (!cond) {
    failures.push(label + (detail ? ' — ' + detail : ''));
  }
}
const failures = [];

function hasPair(arr, a, b) {
  const i = arr.indexOf(a);
  return i !== -1 && arr[i + 1] === b;
}

function snapshotInvariants(snap, cfg, ctx) {
  ok(snap && typeof snap === 'object', 'I0 snapshot object', ctx);
  if (!snap) return;

  // I1 score bounds
  ok(Number.isFinite(snap.overall.score) && snap.overall.score >= 0 && snap.overall.score <= 100,
    'I1 score in [0,100]', ctx + ' score=' + snap.overall.score);

  // I2 level ↔ score thresholds
  const expected = snap.overall.score >= 95 ? 'ok' : snap.overall.score >= 50 ? 'warn' : 'critical';
  ok(snap.overall.level === expected, 'I2 level matches score', ctx + ' level=' + snap.overall.level + ' score=' + snap.overall.score);

  // I3 outage shape
  if (snap.controller.status === 'unreachable') {
    ok(snap.overall.level === 'critical' && snap.overall.score === 0, 'I3 outage critical/0', ctx);
    ok(snap.overall.reasons.some((r) => /unreachable/i.test(r)), 'I3 unreachable reason', ctx);
  } else {
    ok(snap.controller.level === 'ok' || snap.controller.level === 'warn' || snap.controller.level === 'critical',
      'I6 controller level set', ctx);
  }

  // I4 backlog ⟺ depth > threshold
  ok(snap.queue.backlog === (snap.queue.depth > cfg.queueBacklogThreshold),
    'I4 backlog iff depth>threshold', ctx + ' depth=' + snap.queue.depth + ' thr=' + cfg.queueBacklogThreshold);
  ok(snap.queue.stuck >= 0 && snap.queue.depth >= 0, 'I4 queue counts non-negative', ctx);

  // I5/I6 nodes
  for (const n of snap.nodes) {
    ok(n.state === 'online' || n.state === 'offline', 'I5 node state', ctx + ' ' + n.displayName);
    ok(LEVELS.has(n.level), 'I6 node level set', ctx + ' ' + n.displayName);
    ok(n.level === 'ok' || n.reasons.length > 0, 'I6 non-ok node has reasons', ctx + ' ' + n.displayName);
    if (n.level === 'critical') ok(n.reasons.length > 0, 'I6 critical node has reasons', ctx);
    ok(n.utilization >= 0 && n.utilization <= 1, 'I5 utilization in [0,1]', ctx + ' ' + n.displayName);
  }

  // I7 no secrets anywhere
  const blob = JSON.stringify(snap);
  ok(!SECRET_RE.test(blob), 'I7 no secrets in snapshot', ctx);
}

function eventInvariants(events, ctx) {
  ok(Array.isArray(events), 'I8 events array', ctx);
  for (const e of events) {
    ok(typeof e.type === 'string' && EVENT_TYPES.has(e.type), 'I9 event type', ctx + ' ' + JSON.stringify(e.type));
    ok(SEVERITIES.has(e.severity), 'I9 event severity', ctx + ' ' + JSON.stringify(e.severity));
    ok(typeof e.message === 'string' && e.message.trim().length > 0, 'I9 event message', ctx);
    ok(!SECRET_RE.test(e.message), 'I7 no secrets in messages', ctx);
  }
}

// ------------------------------------------------------------------ scenarios

const N = 600;
for (let iter = 0; iter < N; iter++) {
  const cfg = genConfig();
  const api = genApi();
  const computer = genComputer();
  const queue = genQueue(NOW);
  const plugins = genPlugins();
  const uc = genUc();
  const header = chance(0.9) ? '2.4' + ri(0, 9) + '.' + ri(0, 9) + '\n' : null;
  const ctx = 'iter' + iter;
  const apiClone = structuredClone(api);
  const computerClone = structuredClone(computer);

  // I10 parsers never throw on anything
  let controller, nodes, queueP, pluginsP, ucP;
  try {
    controller = Model.parseController(api, header);
    nodes = Model.parseNodes(computer);
    queueP = Model.parseQueue(queue);
    pluginsP = Model.parsePlugins(plugins);
    ucP = Model.parseUpdateCenter(uc);
  } catch (e) {
    ok(false, 'I10 parser throws', ctx + ' ' + e.message);
    continue;
  }
  // parse invariants. Version contract: the header wins whenever the api
  // body is an object (a jobs-less controller still has a version);
  // "Unknown" only for non-object input.
  const apiIsObject = api && typeof api === 'object' && !Array.isArray(api);
  if (apiIsObject) {
    const expectedVersion = header && String(header).trim() ? String(header).trim() : 'Unknown';
    ok(controller.version === expectedVersion, 'I5 version contract', ctx
      + ' got=' + controller.version + ' want=' + expectedVersion);
    if (Array.isArray(api.jobs)) {
      ok(controller.jobs.length === api.jobs.length, 'I5 jobs preserved', ctx);
    } else {
      ok(controller.jobs.length === 0, 'I5 no jobs array → none', ctx);
    }
  } else {
    ok(controller.version === 'Unknown', 'I5 malformed api → Unknown version', ctx);
    ok(controller.jobs.length === 0, 'I5 malformed api → no jobs', ctx);
  }
  if (computer && Array.isArray(computer.computer)) {
    ok(nodes.nodes.length === computer.computer.length, 'I5 nodes preserved', ctx);
  } else {
    ok(nodes.total === 0 && nodes.nodes.length === 0, 'I5 malformed computer → empty', ctx);
  }
  if (queue && typeof queue === 'object' && Array.isArray(queue.items)) {
    ok(queueP.depth === queue.items.length, 'I5 queue depth', ctx);
  } else {
    ok(queueP.depth === 0, 'I5 malformed queue → 0', ctx);
  }
  // I11 purity: the parses above must not have mutated their inputs
  ok(JSON.stringify(api) === JSON.stringify(apiClone), 'I11 parseController purity', ctx);
  ok(JSON.stringify(computer) === JSON.stringify(computerClone), 'I11 parseNodes purity', ctx);

  // outage variant
  const snapOutage = Model.assess(null, null, null, null, null, cfg, NOW);
  snapshotInvariants(snapOutage, cfg, ctx + '/outage');
  ok(snapOutage.controller.status === 'unreachable', 'I3 outage status', ctx);

  // main assessment
  let snap;
  try {
    snap = Model.assess(controller, nodes, queueP, pluginsP, ucP, cfg, NOW);
  } catch (e) {
    ok(false, 'I10 assess throws', ctx + ' ' + e.message);
    continue;
  }
  snapshotInvariants(snap, cfg, ctx);

  // determinism: same inputs → same output
  const snap2 = Model.assess(controller, nodes, queueP, pluginsP, ucP, cfg, NOW);
  ok(JSON.stringify(snap) === JSON.stringify(snap2), 'I11 assess deterministic', ctx);

  // diffing
  let events1, eventsSelf, eventsNull;
  const snapOutage2 = Model.assess(null, null, null, null, null, cfg, NOW);
  try {
    events1 = Model.diffEvents(snap, snapOutage2, cfg);
    eventsSelf = Model.diffEvents(snap, snap, cfg);
    eventsNull = Model.diffEvents(null, snap, cfg);
  } catch (e) {
    ok(false, 'I10 diffEvents throws', ctx + ' ' + e.message);
    continue;
  }
  eventInvariants(events1, ctx + '/diff-outage');
  eventInvariants(eventsSelf, ctx + '/diff-self');
  eventInvariants(eventsNull, ctx + '/diff-null');
  ok(eventsSelf.length === 0, 'I8 identical → no events', ctx);
  ok(eventsNull.length === 0, 'I8 null prev → no events', ctx);
  // controller toggles suppress controller events
  const cfgNoController = { ...cfg, notifyController: false };
  const noCtrl = Model.diffEvents(snap, snapOutage2, cfgNoController);
  ok(!noCtrl.some((e) => e.type === 'controller-down'), 'I8 notifyController off suppresses down', ctx);
  // purity of diffEvents
  const snapClone = structuredClone(snap);
  Model.diffEvents(snap, snapOutage2, cfg);
  ok(JSON.stringify(snap) === JSON.stringify(snapClone), 'I11 diffEvents purity', ctx);

  // command builders (every iteration)
  const user = 'u' + iter;
  const token = 'tok' + iter;
  const url = 'https://ci' + (iter % 5) + '.example.com:' + pick([8080, 8443]) + pick(['', '/jenkins']);
  const netrc = Model.buildNetrc(user, token, url);
  const netrcLines = netrc.split('\n').map((l) => l.trim());
  ok(netrcLines.length === 3 && netrcLines[0].startsWith('machine ') &&
    netrcLines[1] === 'login ' + user && netrcLines[2] === 'password ' + token,
    'I12 netrc structure', ctx + ' ' + JSON.stringify(netrc));
  ok(!netrcLines[0].includes('://') && !/:\/\//.test(netrcLines[0]), 'I12 netrc host clean', ctx);

  const crumb = chance(0.5) ? 'crumb-' + iter : null;
  const args = Model.buildCurlArgs('/api/json', 'GET', url, '/tmp/n', crumb);
  ok(args[0] === 'curl' && args[1] === '-fsS', 'I13 curl prefix', ctx);
  ok(hasPair(args, '--max-time', '8') && hasPair(args, '--netrc-file', '/tmp/n'), 'I13 curl pairs', ctx);
  const urlArg = args[args.length - 1];
  ok(!urlArg.includes('//jenkins') || urlArg.includes('://'), 'I13 no double slash', ctx + ' ' + urlArg);
  ok(urlArg.startsWith('https://') && urlArg.endsWith('/api/json'), 'I13 url join', ctx + ' ' + urlArg);
  ok(args.some((a) => String(a).includes('Jenkins-Crumb')) === (crumb !== null), 'I13 crumb presence', ctx);

  const action = pick(['cancelQueueItem', 'quietDown', 'cancelQuietDown', 'nodeOffline', 'nodeOnline', 'bogusAction']);
  const cmd = Model.buildActionCommand({ action, targetId: '42' }, null, url, '/tmp/n', crumb);
  if (action === 'bogusAction') {
    ok(Array.isArray(cmd) && cmd.length === 0, 'I14 unknown action → empty', ctx);
  } else {
    ok(Array.isArray(cmd) && cmd[0] === 'curl' && hasPair(cmd, '-X', 'POST'), 'I14 action POST', ctx);
    ok(cmd[cmd.length - 1].startsWith('https://'), 'I14 action url', ctx);
  }
}

// ------------------------------------------- nested-folder flattening (N*)
// The tree query returns folders with a `jobs` array; parseController must
// flatten to runnable leaves, prefix folder names, drop empty folders, and
// keep flat listings identity — the frozen harness fixtures are flat, so
// these invariants carry the nested contract.

function genNestedApi() {
  const top = [];
  const flatEquiv = [];
  let folders = 0, leaves = 0, emptyFolders = 0, grandchildren = 0;
  const n = ri(1, 6);
  for (let f = 0; f < n; f++) {
    if (chance(0.2)) {
      // plain top-level runnable job (mixed shape, like a controller with
      // both folders and loose jobs)
      const j = { name: 'loose-' + f, color: pick(COLORS) };
      top.push(structuredClone(j));
      flatEquiv.push(structuredClone(j));
      leaves++;
      continue;
    }
    folders++;
    const kids = [];
    const k = ri(0, 5);
    if (k === 0) emptyFolders++;
    for (let i = 0; i < k; i++) {
      if (chance(0.2)) {
        // nested subfolder one more level down
        const gk = ri(0, 3);
        const gkids = [];
        for (let g = 0; g < gk; g++) {
          const gj = { name: 'g-' + f + '-' + i + '-' + g, color: pick(COLORS) };
          gkids.push(structuredClone(gj));
          flatEquiv.push({ name: 'folder-' + f + '/sub-' + i + '/' + gj.name, color: gj.color });
          leaves++;
          grandchildren++;
        }
        kids.push({ name: 'sub-' + i, color: null, jobs: gkids });
      } else {
        const j = { name: 'leaf-' + f + '-' + i, color: pick(COLORS) };
        kids.push(structuredClone(j));
        flatEquiv.push({ name: 'folder-' + f + '/' + j.name, color: j.color });
        leaves++;
      }
    }
    top.push({ name: 'folder-' + f, color: null, jobs: kids });
  }
  return {
    api: {
      mode: 'NORMAL', quietingDown: false, useCrumbs: true,
      useSecurity: true, numExecutors: ri(0, 5), jobs: top,
    },
    flatEquiv, leaves, folders, emptyFolders, grandchildren,
  };
}

for (let iter = 0; iter < 300; iter++) {
  const g = genNestedApi();
  const ctx = 'nested' + iter;
  let controller;
  try {
    controller = Model.parseController(g.api, '2.460.1');
  } catch (e) {
    ok(false, 'N1 flatten throws', ctx + ' ' + e.message);
    continue;
  }
  ok(controller.jobs.length === g.leaves, 'N2 leaf count preserved', ctx
    + ' got=' + controller.jobs.length + ' want=' + g.leaves);
  ok(controller.jobs.length === g.flatEquiv.length, 'N2 equiv length', ctx);
  let namesMatch = true;
  for (let i = 0; i < g.flatEquiv.length; i++) {
    if (controller.jobs[i].name !== g.flatEquiv[i].name
      || controller.jobs[i].color !== g.flatEquiv[i].color) { namesMatch = false; break; }
  }
  ok(namesMatch, 'N3 names/colors match pre-flattened equivalent (folder-prefixed)', ctx);
  ok(controller.jobs.every(j => !j.name.startsWith('sub-') || j.name.includes('/')),
    'N4 folder entries never surface bare', ctx);
  ok(controller.jobs.filter(j => j.name.startsWith('folder-') && !j.name.includes('/')).length === 0,
    'N4 top folders never surface', ctx);

  // assess equivalence: the snapshot from nested input must equal the one
  // from the manually-flattened input (failures feed, score, everything).
  const cfg = genConfig();
  const flatApi = { ...g.api, jobs: structuredClone(g.flatEquiv) };
  const flatCtrl = Model.parseController(flatApi, '2.460.1');
  const computer = genComputer();
  const queue = genQueue(NOW);
  const plugins = genPlugins();
  const uc = genUc();
  const sNest = Model.assess(controller, Model.parseNodes(computer), Model.parseQueue(queue),
    Model.parsePlugins(plugins), Model.parseUpdateCenter(uc), cfg, NOW);
  const sFlat = Model.assess(flatCtrl, Model.parseNodes(computer), Model.parseQueue(queue),
    Model.parsePlugins(plugins), Model.parseUpdateCenter(uc), cfg, NOW);
  ok(sNest.overall.score === sFlat.overall.score && sNest.overall.level === sFlat.overall.level,
    'N5 assess(score/level) identical nested vs flattened', ctx);
  ok(JSON.stringify(sNest.jobs) === JSON.stringify(sFlat.jobs), 'N5 assess jobs identical', ctx);
}

// N6 real-world shape regression: folders-with-children, an empty folder,
// and every color class — the real-world folder-organized controller profile.
{
  const api = {
    mode: 'NORMAL', quietingDown: false, useCrumbs: true, useSecurity: true, numExecutors: 0,
    jobs: [
      { name: 'MobileGames', color: null, jobs: [
        { name: 'Puzzle3D-Develop', color: 'red' },
        { name: 'TemplateJob', color: 'notbuilt' },
        { name: 'Puzzle3D-Creative', color: 'disabled' },
      ] },
      { name: 'EmptyFolder', color: null, jobs: [] },
      { name: 'Delivery', color: null, jobs: [
        { name: 'IosApp', color: 'red' },
        { name: 'NativeApp', color: 'blue' },
      ] },
      { name: 'LooseJob', color: 'yellow' },
    ],
  };
  const ctrl = Model.parseController(api, '2.568.2');
  ok(ctrl.jobs.length === 6, 'N6 leaf count on real-world shape', 'got ' + ctrl.jobs.length);
  const reds = ctrl.jobs.filter(j => j.color === 'red').map(j => j.name).sort();
  ok(JSON.stringify(reds) === JSON.stringify(['Delivery/IOS', 'MobileGames/Puzzle3D-Develop']),
    'N6 folder-prefixed failing jobs', JSON.stringify(reds));
  ok(ctrl.jobs.some(j => j.name === 'LooseJob' && j.color === 'yellow'),
    'N6 loose top-level job survives', '');
}

// N7 truncated folder: a folder deeper than the tree query's depth comes
// back with color null and NO `jobs` attribute — it must surface as a
// neutral leaf (not crash, not count as failing), and sibling leaves stay
// intact.
{
  const api = {
    jobs: [
      { name: 'Deep', color: null, jobs: [
        { name: 'mid', color: null }, // folder beyond tree depth
        { name: 'real', color: 'red' },
      ] },
    ],
  };
  const t = Model.parseController(api, '1.0');
  ok(t.jobs.length === 2, 'N7 truncated folder surfaces as leaf', 'got ' + t.jobs.length);
  ok(t.jobs.some(j => j.name === 'Deep/mid' && j.color === ''), 'N7 truncated folder neutral color', '');
  ok(t.jobs.filter(j => j.color === 'red').length === 1, 'N7 sibling leaf unaffected', '');
}
// ------------------------------------------------------------------- summary

console.log(`property sweep: ${N} scenarios, ${checks} checks`);
if (failures.length > 0) {
  const unique = [...new Set(failures)];
  console.log(`FAILURES: ${failures.length} (${unique.length} unique)`);
  for (const f of unique.slice(0, 25)) console.log('  ' + f);
  process.exit(1);
}
console.log('ALL INVARIANTS HOLD (seed ' + SEED + ')');
