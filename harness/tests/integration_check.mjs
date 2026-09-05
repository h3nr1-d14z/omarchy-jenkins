#!/usr/bin/env node
// Per-scenario validation for the jenkins-health integration tests.
//
// usage: node integration_check.mjs <healthy|degraded|outage> <fetched-dir>
//
// The bash integration script fetched the mock server's endpoints with real
// curl into <fetched-dir> (api.json, computer.json, queue.json,
// pluginManager.json, updateCenter.json, headers.txt). This script runs the
// plugin's real Model.js over those wire payloads — the full
// HTTP -> parse -> assess pipeline — and asserts scenario expectations.
// The outage scenario validates no JSON; it checks that Model.js classifies
// an unreachable controller as critical.
//
// Missing Model.js makes every scenario fail (exit 1): the integration
// checks measure plugin completeness, not mock-server health.

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const [scenario, dir] = process.argv.slice(2);
if (!scenario || !dir) {
  console.error('usage: integration_check.mjs <healthy|degraded|outage> <fetched-dir>');
  process.exit(1);
}

const NOW = 1704067200000;
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

let M = null;
try {
  const mod = await import(new URL('../../Model.js', import.meta.url).href);
  M = typeof mod.parseController === 'function' ? mod : (mod.default ?? null);
} catch {
  // fall through to the not-found report below
}
if (M === null) {
  console.log(`[${scenario}] Model.js not found — cannot validate`);
  process.exit(1);
}

const readJson = (name) => JSON.parse(readFileSync(`${dir}/${name}`, 'utf8'));
const readHeader = () => {
  const headers = readFileSync(`${dir}/headers.txt`, 'utf8');
  const m = headers.match(/^X-Jenkins:\s*(.+)$/im);
  return m ? m[1].trim() : '';
};

const fail = (e) => {
  console.log(`[${scenario}] ${e.message ?? e}`);
  process.exit(1);
};

const assessParsed = (parsed) => M.assess(parsed.controller, parsed.nodes, parsed.queue, parsed.plugins, parsed.updateCenter, CONFIG, NOW);

if (scenario === 'healthy' || scenario === 'degraded') {
  try {
    const snap = assessParsed({
      controller: M.parseController(readJson('api.json'), readHeader()),
      nodes: M.parseNodes(readJson('computer.json')),
      queue: M.parseQueue(readJson('queue.json')),
      plugins: M.parsePlugins(readJson('pluginManager.json')),
      updateCenter: M.parseUpdateCenter(readJson('updateCenter.json')),
    });
    if (scenario === 'healthy') {
      assert.equal(snap.controller.status, 'up');
      assert.equal(snap.overall.level, 'ok');
      assert.equal(M.parseController(readJson('api.json'), readHeader()).version, '2.440.3');
      assert.equal(snap.nodes.length, 6);
      assert.equal(snap.queue.depth, 2);
    } else {
      assert.equal(snap.overall.level, 'warn');
      assert.equal(snap.queue.depth, 12);
      assert.equal(snap.nodes.filter((n) => n.state === 'offline').length, 1);
      assert.equal(snap.maintenance.updatesAvailable, 3);
    }
  } catch (e) {
    fail(e);
  }
} else if (scenario === 'outage') {
  try {
    const snap = M.assess(null, null, null, null, null, CONFIG, NOW);
    assert.equal(snap.controller.status, 'unreachable');
    assert.equal(snap.overall.level, 'critical');
    assert.equal(snap.overall.score, 0);
  } catch (e) {
    fail(e);
  }
} else {
  console.error(`unknown scenario: ${scenario}`);
  process.exit(1);
}

process.exit(0);
