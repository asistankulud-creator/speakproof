/**
 * Integration test for the relay server.
 * Runs in stub mode: exercises the real WebSocket protocol, real disclosure
 * tracking and the real status payloads the UI consumes — with no API calls
 * and no credits spent, so it is safe to run in CI on every commit.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 34117;
let proc;

const waitFor = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return true; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('timed out waiting for condition');
};

before(async () => {
  proc = spawn(process.execPath, [join(root, 'src', 'server.mjs')], {
    env: { ...process.env, PORT: String(PORT), SPEAKPROOF_STUB: '1', ASSEMBLYAI_API_KEY: '' },
    stdio: 'ignore',
  });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok);
});

after(() => proc?.kill());

test('healthz reports stub mode and does not leak key material', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.stub, true);
  assert.deepEqual(Object.keys(body).sort(), ['keyPresent', 'ok', 'stub']);
  assert.equal(typeof body.keyPresent, 'boolean', 'exposes presence only, never the value');
});

test('static index is served', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /Speakproof/);
});

test('path traversal is refused', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/../package.json`);
  assert.notEqual(res.status, 200);
});

/** Collect messages until `predicate` is satisfied, then resolve. */
function session(onOpen, predicate, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const seen = [];
    const timer = setTimeout(() => { ws.close(); reject(new Error('ws timeout')); }, timeout);
    ws.on('open', () => onOpen(ws));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      seen.push(msg);
      if (predicate(msg, seen)) { clearTimeout(timer); ws.close(); resolve(seen); }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

test('handshake announces scenario and an all-unsatisfied checklist', async () => {
  const seen = await session(() => {}, (m) => m.type === 'ready');
  const ready = seen.find((m) => m.type === 'ready');
  assert.equal(ready.stub, true);
  assert.equal(ready.scenario.id, 'investment_suitability');
  assert.equal(ready.status.complete, false);
  assert.ok(ready.status.items.length >= 5);
  assert.equal(ready.status.items.every((i) => !i.satisfied), true);
});

test('a full scripted call drives the checklist to complete', async () => {
  const script = [
    ['rep', 'This call is recorded for quality.'],
    ['customer', 'So these returns are guaranteed, right?'],
    ['rep', 'Past performance does not guarantee future results.'],
    ['rep', 'You could lose principal, and it is not FDIC insured.'],
    ['rep', 'Our advisory fee is 0.8 percent annually.'],
  ];
  const seen = await session(
    (ws) => { for (const [speaker, text] of script) ws.send(JSON.stringify({ type: 'stub', text, speaker })); },
    (m) => m.type === 'turn' && m.status?.complete === true
  );

  const final = seen.filter((m) => m.type === 'turn').at(-1);
  assert.equal(final.status.complete, true);

  // The customer's question must not have satisfied anything.
  const customerTurn = seen.find((m) => m.type === 'turn' && m.speaker === 'customer');
  assert.deepEqual(customerTurn.newlySatisfied, [], 'customer speech must never satisfy a rep disclosure');

  // Evidence is retained for the audit record.
  const guarantee = final.status.items.find((i) => i.id === 'no_guarantee');
  assert.match(guarantee.evidence, /does not guarantee/i);
});

test('an incomplete call still reports missing critical items', async () => {
  const seen = await session(
    (ws) => ws.send(JSON.stringify({ type: 'stub', text: 'This call is recorded.', speaker: 'rep' })),
    (m) => m.type === 'turn'
  );
  const turn = seen.find((m) => m.type === 'turn');
  assert.equal(turn.status.complete, false);
  const missingCritical = turn.status.items.filter((i) => !i.satisfied && i.critical);
  assert.equal(missingCritical.length, 3, 'guarantee, principal risk and FDIC all still outstanding');
});
