/**
 * Live verification against AssemblyAI. Two independent checks:
 *
 *   1. STREAMING  — open the v3 WebSocket with header auth, confirm a `Begin`
 *                   session event, push a short PCM16 frame, then Terminate.
 *                   Proves the relay's upstream path and credentials.
 *   2. TRANSCRIBE — submit a public audio URL to the async API and poll until
 *                   completion. Proves the account can actually produce a real
 *                   transcript, without needing a microphone or ffmpeg locally.
 *
 * Run: node scripts/verify-live.mjs
 * Requires ASSEMBLYAI_API_KEY in the environment. Never prints the key.
 */
import { WebSocket } from 'ws';

const KEY = process.env.ASSEMBLYAI_API_KEY;
if (!KEY) { console.error('ASSEMBLYAI_API_KEY not set'); process.exit(1); }

const SAMPLE_RATE = 16000;
const log = (...a) => console.log(...a);

async function checkStreaming() {
  log('\n[1/2] STREAMING — wss://streaming.assemblyai.com/v3/ws');
  const url = `wss://streaming.assemblyai.com/v3/ws?sample_rate=${SAMPLE_RATE}&speech_model=universal-3-5-pro&format_turns=true`;
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { Authorization: KEY } });
    const result = { opened: false, began: false, sessionId: null, terminated: false, error: null };
    const done = () => { try { ws.close(); } catch {} resolve(result); };
    const timer = setTimeout(() => { result.error ??= 'timeout'; done(); }, 20000);

    ws.on('open', () => {
      result.opened = true;
      log('  ✓ socket open (header auth accepted)');
      // 200 ms of silent PCM16 — enough to exercise the audio path.
      ws.send(Buffer.alloc(SAMPLE_RATE * 2 * 0.2));
      setTimeout(() => { try { ws.send(JSON.stringify({ type: 'Terminate' })); } catch {} }, 1200);
    });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'Begin') { result.began = true; result.sessionId = m.id; log(`  ✓ Begin — session ${m.id}`); }
      if (m.type === 'Turn' && m.transcript) log(`  · Turn: "${m.transcript}"`);
      if (m.type === 'Termination') {
        result.terminated = true;
        log(`  ✓ Termination — audio ${m.audio_duration_seconds}s, session ${m.session_duration_seconds}s`);
        clearTimeout(timer); done();
      }
    });
    ws.on('error', (e) => { result.error = e.message; log(`  ✗ ${e.message}`); clearTimeout(timer); done(); });
    ws.on('close', () => { clearTimeout(timer); resolve(result); });
  });
}

async function checkTranscription() {
  log('\n[2/2] TRANSCRIBE — async API on a public sample');
  const audio_url = 'https://assembly.ai/wildfires.mp3';
  const post = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: { Authorization: KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ audio_url }),
  });
  if (!post.ok) { log(`  ✗ submit failed HTTP ${post.status}: ${(await post.text()).slice(0, 200)}`); return { ok: false }; }
  const { id } = await post.json();
  log(`  · submitted, id=${id}`);

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, { headers: { Authorization: KEY } });
    const t = await res.json();
    if (t.status === 'completed') {
      log(`  ✓ completed — ${t.audio_duration}s audio, ${t.text.length} chars`);
      log(`  · first 180 chars: "${t.text.slice(0, 180)}…"`);
      return { ok: true, chars: t.text.length, duration: t.audio_duration };
    }
    if (t.status === 'error') { log(`  ✗ ${t.error}`); return { ok: false, error: t.error }; }
    if (i % 3 === 0) log(`  · status=${t.status}`);
  }
  return { ok: false, error: 'poll timeout' };
}

const stream = await checkStreaming();
const trans = await checkTranscription();

log('\n=== RESULT ===');
log(`streaming:     open=${stream.opened} begin=${stream.began} terminate=${stream.terminated}${stream.error ? ' error=' + stream.error : ''}`);
log(`transcription: ok=${trans.ok}${trans.chars ? ` chars=${trans.chars} duration=${trans.duration}s` : ''}`);
process.exit(stream.began && trans.ok ? 0 : 1);
