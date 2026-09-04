# Speakproof

**Live disclosure-compliance guardrail for regulated conversations.**

Regulated calls — financial advice, insurance, healthcare intake — legally require specific disclosures to be spoken aloud. People forget them under pressure, and nobody finds out until an audit. Speakproof listens to the call in real time, tracks which required disclosures were **actually said**, warns while the call is still live, and emits an auditable record afterwards.

Built on [AssemblyAI](https://www.assemblyai.com) streaming speech-to-text.

---

## Why this is not just "transcribe and search"

Two failure modes make naive keyword matching actively dangerous, and both are covered by tests:

**1. Inversion.** A representative saying *"these returns are guaranteed"* contains the word `guaranteed`. A substring search would tick the *"past performance does not guarantee future results"* box — on the exact sentence that creates liability. Speakproof matches **cue groups**, where every term in a group must be present, so `["past performance", "not", "guarantee"]` cannot be satisfied by the inversion.

**2. Wrong speaker.** A customer asking *"so it's not guaranteed?"* contains the required words. Only the **representative's** speech can satisfy a disclosure; customer turns are ignored.

## Architecture

```
browser mic ──PCM16 16kHz──▶ relay server ──▶ AssemblyAI streaming (v3)
browser UI  ◀─────JSON──────  relay server ◀── Turn events
```

The relay is **required, not incidental**: AssemblyAI authenticates streaming with an `Authorization` header, and browsers cannot set headers on WebSocket connections. It also keeps the API key server-side, where it belongs — the client never sees it.

Finalized turns (`end_of_turn`, preferring the formatted variant) feed the disclosure tracker; the updated checklist is pushed to the UI on every turn.

## Run it

```bash
npm install
ASSEMBLYAI_API_KEY=your_key npm start   # live
npm start                                # stub mode (no key, no credits)
```

Then open <http://localhost:3000>.

**Stub mode** runs the entire pipeline — WebSocket protocol, disclosure tracking, UI updates — with a synthetic transcript source and zero API calls. The "Run scripted demo" button exercises it end to end without a microphone.

## Tests

```bash
node --test test/disclosures.test.mjs test/server.test.mjs
```

14 tests, no credits consumed: disclosure logic (including the inversion and wrong-speaker cases), plus server integration over a real WebSocket — handshake, checklist completion, path-traversal refusal, and a check that `/healthz` exposes key *presence* but never key *material*.

Live connectivity is verified separately:

```bash
node scripts/verify-live.mjs
```

which confirms streaming header auth + `Begin`/`Termination`, and submits a public sample to the async API to prove real transcription.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ASSEMBLYAI_API_KEY` | — | AssemblyAI key. Absent ⇒ stub mode. |
| `PORT` | `3000` | HTTP/WS port. |
| `SPEAKPROOF_MODEL` | `universal-3-5-pro` | Streaming speech model. |
| `SPEAKPROOF_STUB` | — | `1` forces stub mode even with a key. |

## Scenarios

`src/disclosures.mjs` ships one illustrative scenario (investment suitability). Disclosure wording there is a **demonstration of the mechanism, not legal advice** — real deployments load their own compliance-approved set. Adding a scenario means adding cue groups; no code changes.

## License

MIT
