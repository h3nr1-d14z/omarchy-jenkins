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
  'node-disk-low', 'node-disk-critical', 'node-disk-unknown', 'node-disk-ok',
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
  if (chance(0.12)) node.oneOffExecutors = Array.from({ length: ri(1, 2) }, () => ({}));
  if (chance(0.1)) delete node.monitorData['hudson.node_monitors.TemporarySpaceMonitor'];
  if (chance(0.08)) node.monitorData['hudson.node_monitors.DiskSpaceMonitor'] = { path: '/', size: null };
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
    // disk tier is a dedicated field (never derived from level, which
    // folds offline/slow causes) and keys on the worse of workspace/tmp.
    const vols = [n.diskGb, n.tmpGb].filter((v) => v !== null && v !== undefined);
    const worst = vols.length ? Math.min(...vols) : null;
    const expectedTier = worst === null
      ? (n.state === 'online' ? 'unknown' : null)
      : (worst < cfg.diskCriticalGb ? 'critical' : (worst < cfg.diskWarnGb ? 'low' : 'ok'));
    ok(n.diskTier === expectedTier, 'I6 diskTier = tier(min(workspace, tmp))', ctx
      + ' ' + n.displayName + ' tier=' + n.diskTier + ' want=' + expectedTier);
    ok(n.oneOffBusy === undefined || Number.isInteger(n.oneOffBusy), 'I5 oneOffBusy integer', ctx);
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

  const action = pick(['cancelQueueItem', 'quietDown', 'cancelQuietDown', 'nodeOffline', 'nodeOnline',
    'workspaceCleanup', 'nodeWorkspaceList', 'nodeWorkspaceClean', 'bogusAction']);
  const cmd = Model.buildActionCommand({ action, targetId: '42' }, null, url, '/tmp/n', crumb);
  if (action === 'bogusAction') {
    ok(Array.isArray(cmd) && cmd.length === 0, 'I14 unknown action → empty', ctx);
  } else {
    ok(Array.isArray(cmd) && cmd[0] === 'curl' && hasPair(cmd, '-X', 'POST'), 'I14 action POST', ctx);
    ok(cmd[cmd.length - 1].startsWith('https://'), 'I14 action url', ctx);
  }
  if (action === 'nodeWorkspaceList' || action === 'nodeWorkspaceClean') {
    ok(cmd[cmd.length - 1].endsWith('/scriptText'), 'I14 scriptText url', ctx);
    const si = cmd.indexOf('--data-urlencode');
    ok(si !== -1 && String(cmd[si + 1]).startsWith('script='), 'I14 script body data', ctx);
    ok(String(cmd[si + 1]).includes("getComputer('42')"), 'I14 node name interpolated', ctx);
  }
  if (action === 'workspaceCleanup') {
    ok(cmd[cmd.length - 1].endsWith('/doWorkspaceCleanup'), 'I14 workspaceCleanup url', ctx);
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
// and every color class — a folder-organized controller profile.
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
  const ctrl = Model.parseController(api, '2.440.3');
  ok(ctrl.jobs.length === 6, 'N6 leaf count on real-world shape', 'got ' + ctrl.jobs.length);
  const reds = ctrl.jobs.filter(j => j.color === 'red').map(j => j.name).sort();
  ok(JSON.stringify(reds) === JSON.stringify(['Delivery/IosApp', 'MobileGames/Puzzle3D-Develop']),
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

// C*: failurePenaltyCap semantics. Default 0/absent = uncapped (the
// frozen fixtures depend on that); a positive cap bounds only the score
// subtraction — counts, names, and reasons keep the truth.
{
  const api = (nRed) => ({ mode: 'NORMAL', quietingDown: false,
    jobs: Array.from({ length: nRed }, (_, i) => ({ name: 'r' + i, color: 'red' })) });
  const mk = (nRed, cap) => Model.assess(
    Model.parseController(api(nRed), '1.0'),
    Model.parseNodes({ computer: [] }),
    Model.parseQueue({ items: [] }),
    Model.parsePlugins({ plugins: [] }),
    Model.parseUpdateCenter({}),
    Object.assign({ queueBacklogThreshold: 10, diskWarnGb: 25, diskCriticalGb: 10, responseTimeWarnMs: 1000 },
      cap !== undefined ? { failurePenaltyCap: cap } : {}),
    0);
  const un5 = mk(5);          // penalty 30
  ok(mk(5, 60).overall.score === un5.overall.score, 'C1 cap above penalty = uncapped', '');
  ok(mk(5, 0).overall.score === un5.overall.score, 'C2 explicit 0 = uncapped', '');
  ok(mk(5, 12).overall.score === 88, 'C3 capped penalty applied', 'got ' + mk(5, 12).overall.score);
  ok(mk(50, 10).overall.score === 90, 'C4 many reds with small cap', 'got ' + mk(50, 10).overall.score);
  ok(mk(50).overall.score === 0, 'C4b uncapped many reds still floor 0', '');
  const capped = mk(50, 10);
  ok(capped.controller.failures === 50 && capped.controller.failingNames.length === 50,
    'C5 counts/names keep the truth under cap', '');
  ok(capped.overall.reasons.some(r => r.indexOf('50 jobs failing') === 0),
    'C5b reason keeps the true count', JSON.stringify(capped.overall.reasons));
}

// J*: job-depth views over the enriched leaf records.
{
  const api = { mode: 'NORMAL', quietingDown: false, jobs: [
    { name: 'F', jobs: [
      { name: 'a', color: 'red', healthReport: [{ score: 0, description: 'All recent builds failed.' }],
        lastBuild: { number: 3, timestamp: 2000, duration: 90000, result: 'FAILURE', building: false },
        lastSuccessfulBuild: null },
      { name: 'b', color: 'blue', healthReport: [{ score: 60, description: '2 of 5 failed.' }],
        lastBuild: { number: 7, timestamp: 1000, duration: 60000, result: 'SUCCESS', building: false },
        lastSuccessfulBuild: { number: 7, timestamp: 1000, duration: 60000 } },
      { name: 'c', color: 'blue' },
      { name: 'd', color: 'red_anime',
        lastBuild: { number: 9, timestamp: 3000, duration: 5000, result: null, building: true },
        lastSuccessfulBuild: { number: 8, timestamp: 500, duration: 500 } }
    ] },
    { name: 'top', color: 'blue',
      lastBuild: { number: 1, timestamp: 4000, duration: 1000, result: 'SUCCESS', building: false },
      lastSuccessfulBuild: { number: 1, timestamp: 4000, duration: 1000 } }
  ] };
  const ctrl = Model.parseController(api, '1.0');
  ok(ctrl.jobs.length === 5, 'J1 enriched leaves collected across levels', '');
  ok(ctrl.jobs[0].name === 'F/a' && ctrl.jobs[0].health === 0
    && ctrl.jobs[0].lastBuild.number === 3 && ctrl.jobs[0].lastSuccess === null,
    'J2 extended fields parsed, folder-prefixed', JSON.stringify(ctrl.jobs[0]));
  ok(ctrl.jobs[2].health === null && ctrl.jobs[2].lastBuild === null
    && ctrl.jobs[2].lastSuccess === null && ctrl.jobs[2].healthDesc === '',
    'J3 absent extended fields degrade to null', JSON.stringify(ctrl.jobs[2]));
  ok(Model.isNeverGreen(ctrl.jobs[0]) && !Model.isNeverGreen(ctrl.jobs[1])
    && !Model.isNeverGreen(ctrl.jobs[2]),
    'J4 never-green = built but never succeeded', '');
  ok(Model.isDegrading(ctrl.jobs[1]) && !Model.isDegrading(ctrl.jobs[0])
    && !Model.isDegrading(ctrl.jobs[2]),
    'J5 degrading = blue ball with health < 100', '');
  const rb = Model.recentBuilds(ctrl.jobs, 10);
  ok(rb.length === 4 && rb[0].name === 'top' && rb[0].timestamp === 4000
    && rb[3].timestamp === 1000,
    'J6 recent sorted newest-first', JSON.stringify(rb.map(b => b.name)));
  ok(Model.recentBuilds(ctrl.jobs, 2).length === 2, 'J6b recent respects limit', '');
  const flat = Model.parseController({ jobs: [{ name: 'x', color: 'blue' }] }, '1');
  ok(Model.recentBuilds(flat.jobs, 10).length === 0
    && Model.folderRollups(flat.jobs)[0].worstHealth === null,
    'J7 flat listings yield empty views', '');
  const ru = Model.folderRollups(ctrl.jobs);
  ok(ru[0].folder === 'F' && ru[0].total === 4 && ru[0].failing === 2
    && ru[0].neverGreen === 1 && ru[0].worstHealth === 0
    && ru[1].folder === '' && ru[1].total === 1,
    'J8 rollups grouped, worst-first', JSON.stringify(ru));
  const sn = Model.assess(ctrl,
    { total: 0, online: 0, offline: 0, temporarilyOffline: 0, nodes: [] },
    { depth: 0, stuck: 0, items: [] },
    { total: 0, updatesAvailable: 0, plugins: [] },
    { restartRequired: false, jobs: [], warnings: [] }, {}, 10000);
  ok(sn.controller.jobs.length === 5 && sn.controller.neverGreen === 1
    && sn.controller.degrading === 1 && sn.controller.built24h === 4
    && sn.controller.recent.length === 4 && sn.controller.rollups.length === 2,
    'J9 assess exposes depth views on the snapshot',
    JSON.stringify({ ng: sn.controller.neverGreen, dg: sn.controller.degrading, b24: sn.controller.built24h }));
  const out = Model.assess(null, null, null, null, null, {}, 0);
  ok(out.controller.jobs.length === 0 && out.controller.recent.length === 0
    && out.controller.rollups.length === 0 && out.controller.built24h === 0,
    'J10 unreachable snapshot keeps the depth fields present', '');
}

// H*: history compaction and sparkline windows.
{
  let pts = [];
  for (let t = 0; t <= 3600; t += 30) pts = Model.historyAppendPt(pts, t, 50 + (t % 10), t % 5);
  const c1 = Model.historyCompactPts(pts, 3600);
  ok(c1.length === 121, 'H1 raw points inside the last hour kept verbatim', 'got ' + c1.length);
  let pts2 = [];
  for (let t = 0; t <= 172800; t += 30) pts2 = Model.historyAppendPt(pts2, t, 60, 1);
  const c2 = Model.historyCompactPts(pts2, 172800);
  // 121 raw hour points + (169200-86400)/300 = 276 buckets
  ok(c2.length === 397, 'H2 24h window compacts to raw-hour + 5-min buckets', 'got ' + c2.length);
  ok(c2[0].t >= 86400, 'H3 points older than 24h dropped', 'first t ' + c2[0].t);
  ok(c2.some(p => p.t === 100170) && !c2.some(p => p.t === 99900),
    'H4 pre-hour buckets keep the newest sample', '');
  ok(JSON.stringify(Model.historyCompactPts(c2, 172800)) === JSON.stringify(c2),
    'H5 compaction is idempotent', '');
  let disks = Model.historyAppendDisk({}, 'n1', 100, 12.5);
  disks = Model.historyAppendDisk(disks, 'n1', 130, 12.4);
  disks = Model.historyAppendDisk(disks, 'n1', 1000, 12.0);
  disks = Model.historyAppendDisk(disks, 'n2', 1000, null);
  ok(disks.n1.length === 3 && disks.n2 === undefined,
    'H6 disk appends per node, null readings skipped', JSON.stringify(Object.keys(disks)));
  const cd = Model.historyCompactDisks(disks, 1000);
  ok(cd.n1.length === 2 && cd.n1[0].t === 130 && cd.n1[1].t === 1000,
    'H7 disk buckets (15 min) keep the newest', JSON.stringify(cd.n1));
  const series = [{ t: 10, v: 1 }, { t: 20, v: 2 }, { t: 21, v: 3 }, { t: 100, v: 9 }];
  const slots = Model.sparklineSlots(series, 100, 90, 3);
  ok(slots.length === 3 && slots[0] === 3 && slots[1] === null && slots[2] === 9,
    'H8 slots keep newest value per window, gaps null', JSON.stringify(slots));
  const hs = Model.historySeries([{ t: 1, s: 66, q: 2 }, { t: 2, s: 0, q: 0 }], 's');
  ok(hs[0].v === 66 && hs[1].v === 0,
    'H9 historySeries maps the field, zero stays zero', JSON.stringify(hs));
  ok(Model.sparklineSlots([{ t: 5, v: 5 }], 100, 90, 3).every(v => v === null),
    'H10 out-of-window points ignored', '');
}

// ------------------------------------------- disk-tier edge triggers (D*)
// The notification contract: tier transitions fire exactly once per edge,
// only while the node is online in the next snapshot, /tmp counts as much
// as the workspace volume, and script-console commands stay templated.

{
  const DISK = 'hudson.node_monitors.DiskSpaceMonitor';
  const TMP = 'hudson.node_monitors.TemporarySpaceMonitor';
  const mk = (diskGb, tmpGb, offline) => ({
    computer: [{
      displayName: 'dnode', offline: !!offline, temporarilyOffline: false,
      monitorData: {
        [DISK]: { path: '/', size: diskGb === null ? null : diskGb * 1e9 },
        [TMP]: { path: '/tmp', size: tmpGb === null ? null : tmpGb * 1e9 },
      },
      executors: [{ idle: true }],
      oneOffExecutors: [],
    }],
  });
  const cfg = { diskWarnGb: 25, diskCriticalGb: 10, notifyNodes: true };
  const snapOf = (computer) => Model.assess(
    Model.parseController({ mode: 'NORMAL' }, '2.568.2'),
    Model.parseNodes(computer),
    { depth: 0, stuck: 0, items: [] }, { total: 0, updatesAvailable: 0, plugins: [] },
    { restartRequired: false, jobs: [], warnings: [] }, cfg, 1000);
  const typesOf = (a, b) => Model.diffEvents(snapOf(a), snapOf(b), cfg)
    .filter((e) => e.type.indexOf('node-disk-') === 0).map((e) => e.type);

  ok(JSON.stringify(typesOf(mk(60, 50), mk(20, 50))) === JSON.stringify(['node-disk-low']),
    'D1 ok→low fires once', '');
  ok(JSON.stringify(typesOf(mk(20, 50), mk(5, 50))) === JSON.stringify(['node-disk-critical']),
    'D2 low→critical fires once', '');
  ok(JSON.stringify(typesOf(mk(5, 50), mk(60, 50))) === JSON.stringify(['node-disk-ok']),
    'D3 critical→ok recovers', '');
  ok(typesOf(mk(20, 50), mk(21, 50)).length === 0, 'D4 same tier → no event', '');
  ok(typesOf(mk(5, 50), mk(5, 50, true)).length === 0,
    'D5 going offline never fires a disk event (stale values)', '');
  ok(typesOf(mk(60, 50), mk(null, null)).length === 0,
    'D6 unknown transitions are Service-debounced, not diffed', '');
  ok(JSON.stringify(typesOf(mk(60, 50), mk(60, 5))) === JSON.stringify(['node-disk-critical']),
    'D7 tmp below critical with healthy workspace fires critical', '');
  ok(typesOf(mk(60, 50), mk(60, 50, true)).length === 0,
    'D9 offline stale tier does not flap against online', '');

  const cfgNoNodes = { ...cfg, notifyNodes: false };
  ok(Model.diffEvents(snapOf(mk(60, 50)), snapOf(mk(5, 50)), cfgNoNodes).length === 0,
    'D7b notifyNodes off suppresses disk events', '');

  // score: online tmp-critical node pays the −10 penalty
  const snapTmp = snapOf(mk(60, 5));
  const snapOk = snapOf(mk(60, 50));
  ok(snapOk.overall.score - snapTmp.overall.score === 10,
    'D10 online tmp-critical node penalized 10', '');
  // offline critical node does not (offline exclusion preserved)
  const snapOff = snapOf(mk(5, 50, true));
  ok(snapOff.nodes[0].state === 'offline' && snapOff.overall.score === snapOk.overall.score - 8,
    'D11 offline node pays only the offline penalty', '');

  // one-off executors count toward busy without breaking utilization
  const withOneOff = structuredClone(mk(60, 50));
  withOneOff.computer[0].oneOffExecutors = [{}];
  const parsedOneOff = Model.parseNodes(withOneOff);
  const snapOneOff = snapOf(withOneOff);
  ok(parsedOneOff.nodes[0].oneOffBusy === 1,
    'D12 one-off busy tracked at parse', '');
  ok(snapOneOff.nodes[0].oneOffBusy === 1 && snapOneOff.nodes[0].utilization === 0,
    'D12 one-off busy surfaces in snapshot, utilization intact', '');

  // script templates: fixed shape, escaped name, no other interpolation
  const listScript = Model.workspaceListScript("a'b\\c");
  ok(listScript.includes("getComputer('a\\'b\\\\c')"),
    'D13 node name escaped in Groovy literal', listScript);
  ok(!listScript.includes('deleteRecursive'), 'D13 list script never deletes', '');
  // built-in node: name is "" and displayName is "Built-In Node" — the
  // templates must fall back to a displayName match or the feature is
  // dead on the one node that needs it most
  ok(Model.workspaceListScript('Built-In Node').includes("displayName == 'Built-In Node'")
    && Model.workspaceCleanScript('Built-In Node').includes("displayName == 'Built-In Node'"),
    'D16 templates resolve computers by displayName fallback', '');
  const cleanScript = Model.workspaceCleanScript('dnode');
  ok(cleanScript.includes('NODE_BUSY') && cleanScript.includes('!c.idle'),
    'D14 clean script guards idleness server-side', '');
  ok(cleanScript.includes('deleteRecursive') && cleanScript.includes('isBuilding'),
    'D14 clean script deletes non-building dirs only', '');
  const scriptCmd = Model.buildScriptCommand(cleanScript, 'https://ci.example.com/', '/tmp/n', 'cr');
  ok(scriptCmd[0] === 'curl' && hasPair(scriptCmd, '--data-urlencode', 'script=' + cleanScript),
    'D15 script body rides --data-urlencode', '');
  ok(scriptCmd[scriptCmd.length - 1] === 'https://ci.example.com/scriptText',
    'D15 scriptText endpoint joined', '');
  ok(hasPair(scriptCmd, '--max-time', '600'), 'D15 script sweep gets a long timeout', '');
  ok(scriptCmd.includes('--fail-with-body') && !scriptCmd.includes('-fsS '),
    'D15 script command keeps the error body on HTTP failures', '');
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
