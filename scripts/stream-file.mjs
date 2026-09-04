/**
 * Stream a WAV file through the live AssemblyAI streaming endpoint exactly as
 * the browser microphone path does — same encoding, same pacing, same message
 * handling — and report the turns plus diarization labels.
 *
 * This is the headless stand-in for a microphone: it exercises the real
 * streaming code path with real speech, deterministically and in CI.
 *
 *   node scripts/stream-file.mjs <path-or-url.wav> [maxSeconds]
 *
 * Pure Node: parses PCM WAV and resamples to 16 kHz mono itself, so no ffmpeg
 * or native dependency is required.
 */
import { WebSocket } from 'ws';
import { readFile } from 'node:fs/promises';

const KEY = process.env.ASSEMBLYAI_API_KEY;
if (!KEY) { console.error('ASSEMBLYAI_API_KEY not set'); process.exit(1); }

const target = process.argv[2];
const maxSeconds = Number(process.argv[3] || 30);
if (!target) { console.error('usage: node scripts/stream-file.mjs <path-or-url.wav> [maxSeconds]'); process.exit(1); }

const TARGET_RATE = 16000;

/** Minimal RIFF/WAVE parser — walks chunks rather than assuming a 44-byte header. */
function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = buf.subarray(pos + 8, pos + 8 + size);
    if (id === 'fmt ') {
      fmt = {
        audioFormat: body.readUInt16LE(0),
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        bitsPerSample: body.readUInt16LE(14),
      };
    } else if (id === 'data') {
      data = body;
    }
    pos += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || !data) throw new Error('missing fmt or data chunk');
  if (fmt.audioFormat !== 1) throw new Error(`unsupported WAV format ${fmt.audioFormat} (need PCM)`);
  if (fmt.bitsPerSample !== 16) throw new Error(`unsupported bit depth ${fmt.bitsPerSample} (need 16)`);
  return { fmt, data };
}

/** Downmix to mono and linearly resample to 16 kHz, returning Int16 PCM. */
function toMono16k({ fmt, data }) {
  const frames = data.length / 2 / fmt.channels;
  const mono = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) acc += data.readInt16LE((f * fmt.channels + c) * 2);
    mono[f] = acc / fmt.channels / 32768;
  }
  if (fmt.sampleRate === TARGET_RATE) return floatToPcm(mono);
  const ratio = fmt.sampleRate / TARGET_RATE;
  const outLen = Math.floor(mono.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio, i0 = Math.floor(src), frac = src - i0;
    out[i] = (mono[i0] ?? 0) * (1 - frac) + (mono[i0 + 1] ?? mono[i0] ?? 0) * frac;
  }
  return floatToPcm(out);
}

function floatToPcm(f32) {
  const pcm = Buffer.alloc(f32.length * 2);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    pcm.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), i * 2);
  }
  return pcm;
}

const raw = /^https?:/.test(target)
  ? Buffer.from(await (await fetch(target)).arrayBuffer())
  : await readFile(target);

const wav = parseWav(raw);
console.log(`source: ${wav.fmt.channels}ch ${wav.fmt.sampleRate}Hz ${wav.fmt.bitsPerSample}bit, ${(wav.data.length / 2 / wav.fmt.channels / wav.fmt.sampleRate).toFixed(1)}s`);

let pcm = toMono16k(wav);
const maxBytes = TARGET_RATE * 2 * maxSeconds;
if (pcm.length > maxBytes) { pcm = pcm.subarray(0, maxBytes); console.log(`trimmed to ${maxSeconds}s to limit credit use`); }
console.log(`streaming ${(pcm.length / 2 / TARGET_RATE).toFixed(1)}s of 16kHz mono PCM16\n`);

const url = `wss://streaming.assemblyai.com/v3/ws?sample_rate=${TARGET_RATE}&speech_model=universal-3-5-pro&format_turns=true&speaker_labels=true`;
const ws = new WebSocket(url, { headers: { Authorization: KEY } });
const labels = new Set();
let finals = 0;

ws.on('open', async () => {
  const CHUNK = TARGET_RATE * 2 * 0.1; // 100 ms frames, paced in real time
  for (let off = 0; off < pcm.length; off += CHUNK) {
    if (ws.readyState !== WebSocket.OPEN) break;
    ws.send(pcm.subarray(off, off + CHUNK));
    await new Promise((r) => setTimeout(r, 100));
  }
  ws.send(JSON.stringify({ type: 'Terminate' }));
});

ws.on('message', (raw) => {
  let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.type === 'Begin') console.log(`session ${m.id}`);
  if (m.type === 'Turn' && m.end_of_turn && m.turn_is_formatted !== false && m.transcript) {
    finals++;
    if (m.speaker_label) labels.add(m.speaker_label);
    console.log(`[${m.speaker_label ?? '—'}] ${m.transcript}`);
  }
  if (m.type === 'Termination') {
    console.log(`\n=== ${finals} final turns | diarization labels seen: ${labels.size ? [...labels].join(', ') : 'NONE'} ===`);
    ws.close();
  }
});
ws.on('error', (e) => { console.error('error:', e.message); process.exit(1); });
