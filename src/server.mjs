/**
 * Speakproof relay server.
 *
 * Browsers cannot set headers on WebSocket connections, and AssemblyAI's
 * streaming endpoint authenticates with an `Authorization` header — so a relay
 * is required rather than optional. It also means the API key never reaches the
 * client, which is where it should never be.
 *
 *   browser mic ──PCM16──▶ this server ──▶ AssemblyAI streaming
 *   browser UI  ◀──JSON─── this server ◀── Turn events
 *
 * Set SPEAKPROOF_STUB=1 to run the whole pipeline with a synthetic transcript
 * source and no API calls — useful for UI work and CI without spending credits.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { DisclosureTracker, SCENARIOS } from './disclosures.mjs';
import { SpeakerRoles } from './speakers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.ASSEMBLYAI_API_KEY;
const STUB = process.env.SPEAKPROOF_STUB === '1' || !API_KEY;

const SAMPLE_RATE = 16000;
const UPSTREAM_URL =
  `wss://streaming.assemblyai.com/v3/ws?sample_rate=${SAMPLE_RATE}` +
  `&speech_model=${encodeURIComponent(process.env.SPEAKPROOF_MODEL || 'universal-3-5-pro')}` +
  `&format_turns=true` +
  // Streaming diarization: each Turn carries speaker_label ("A"/"B"). Required,
  // because only the representative's speech may satisfy a disclosure.
  `&speaker_labels=true`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, stub: STUB, keyPresent: Boolean(API_KEY) }));
  }
  // Static files, path-traversal safe.
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const target = normalize(join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  try {
    const body = await readFile(target);
    const ext = target.slice(target.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (client) => {
  const scenario = SCENARIOS.investment_suitability;
  const tracker = new DisclosureTracker(scenario.disclosures);
  const roles = new SpeakerRoles();
  let upstream = null;
  let closed = false;

  const send = (obj) => client.readyState === WebSocket.OPEN && client.send(JSON.stringify(obj));

  send({ type: 'ready', stub: STUB, scenario: { id: scenario.id, label: scenario.label }, status: tracker.status() });

  /** Apply a finalized turn to the tracker and push the result to the UI. */
  const onFinalTurn = (transcript, speaker = 'rep', speakerLabel = null) => {
    const newly = tracker.ingest(transcript, { speaker });
    send({
      type: 'turn', transcript, final: true, speaker, speakerLabel,
      newlySatisfied: newly, status: tracker.status(), roles: roles.state(),
    });
  };

  if (STUB) {
    // Synthetic source: the client drives it by sending {type:'stub', text}.
    client.on('message', (raw, isBinary) => {
      if (isBinary) return; // ignore audio in stub mode
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'stub' && typeof msg.text === 'string') onFinalTurn(msg.text, msg.speaker || 'rep');
      } catch { /* ignore malformed frames */ }
    });
    client.on('close', () => { closed = true; });
    return;
  }

  upstream = new WebSocket(UPSTREAM_URL, { headers: { Authorization: API_KEY } });

  upstream.on('open', () => send({ type: 'upstream', state: 'open' }));

  upstream.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'Turn') {
      if (msg.end_of_turn) {
        // Prefer the formatted variant when it arrives; it has punctuation/casing.
        if (msg.turn_is_formatted === false) {
          send({ type: 'turn', transcript: msg.transcript, final: false });
        } else {
          const label = msg.speaker_label ?? null;
          onFinalTurn(msg.transcript ?? '', roles.roleFor(label), label);
        }
      } else {
        send({ type: 'turn', transcript: msg.transcript ?? '', final: false });
      }
      return;
    }
    if (msg.type === 'Begin') return send({ type: 'upstream', state: 'session', id: msg.id });
    if (msg.type === 'Termination') return send({ type: 'upstream', state: 'terminated', ...msg });
    if (msg.error || msg.type === 'Error') return send({ type: 'error', message: msg.error ?? 'upstream error' });
  });

  upstream.on('error', (err) => send({ type: 'error', message: `upstream: ${err.message}` }));
  upstream.on('close', (code) => { if (!closed) send({ type: 'upstream', state: 'closed', code }); });

  client.on('message', (raw, isBinary) => {
    if (isBinary) {
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(raw);
      return;
    }
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'stop' && upstream?.readyState === WebSocket.OPEN) {
        upstream.send(JSON.stringify({ type: 'Terminate' }));
      }
      // The "first speaker is the rep" heuristic will sometimes be wrong; let
      // the operator correct it rather than silently mis-crediting disclosures.
      if (msg.type === 'swapSpeakers') {
        roles.swap();
        send({ type: 'roles', roles: roles.state() });
      }
    } catch { /* ignore */ }
  });

  client.on('close', () => {
    closed = true;
    if (upstream?.readyState === WebSocket.OPEN) {
      try { upstream.send(JSON.stringify({ type: 'Terminate' })); } catch { /* already gone */ }
      upstream.close();
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Speakproof listening on http://localhost:${PORT}`);
  console.log(STUB ? '  mode: STUB (no API calls, no credits consumed)' : '  mode: LIVE (AssemblyAI streaming)');
});
