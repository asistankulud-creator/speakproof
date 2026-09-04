import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeakerRoles } from '../src/speakers.mjs';
import { DisclosureTracker, SCENARIOS } from '../src/disclosures.mjs';

test('first speaker heard becomes the representative', () => {
  const r = new SpeakerRoles();
  assert.equal(r.roleFor('A'), 'rep');
  assert.equal(r.roleFor('B'), 'customer');
  assert.equal(r.roleFor('A'), 'rep', 'assignment is stable across turns');
});

test('a third speaker is treated as customer, not promoted to rep', () => {
  const r = new SpeakerRoles();
  r.roleFor('A');
  assert.equal(r.roleFor('C'), 'customer');
  assert.deepEqual(r.state().seen, ['A', 'C']);
});

test('missing diarization falls back to rep', () => {
  // Without speaker labels the audio is assumed to be the rep's own mic —
  // failing closed here would silently satisfy nothing at all.
  const r = new SpeakerRoles();
  assert.equal(r.roleFor(null), 'rep');
  assert.equal(r.roleFor(undefined), 'rep');
  assert.equal(r.roleFor(''), 'rep');
});

test('rep can be assigned explicitly', () => {
  const r = new SpeakerRoles();
  r.roleFor('A');           // A would default to rep
  r.assignRep('B');
  assert.equal(r.roleFor('A'), 'customer');
  assert.equal(r.roleFor('B'), 'rep');
});

test('swap corrects a wrong guess', () => {
  const r = new SpeakerRoles();
  r.roleFor('A');
  r.roleFor('B');
  assert.equal(r.state().repLabel, 'A');
  r.swap();
  assert.equal(r.state().repLabel, 'B');
  assert.equal(r.roleFor('B'), 'rep');
  assert.equal(r.roleFor('A'), 'customer');
});

test('swap is a no-op when only one speaker has been heard', () => {
  const r = new SpeakerRoles();
  r.roleFor('A');
  r.swap();
  assert.equal(r.state().repLabel, 'A');
});

test('end-to-end: diarized call credits only the rep', () => {
  // The compliance case that matters: the customer utters the required words
  // first, and must not satisfy anything.
  const roles = new SpeakerRoles();
  const tracker = new DisclosureTracker(SCENARIOS.investment_suitability.disclosures);

  const turns = [
    ['A', 'Good morning, this call is recorded for quality.'],       // rep
    ['B', 'Right — and past performance does not guarantee results?'], // customer echoes it
    ['A', 'Correct. Past performance does not guarantee future results.'], // rep says it properly
  ];
  for (const [label, text] of turns) tracker.ingest(text, { speaker: roles.roleFor(label) });

  const status = tracker.status();
  assert.equal(status.items.find((i) => i.id === 'recording_notice').satisfied, true);
  const g = status.items.find((i) => i.id === 'no_guarantee');
  assert.equal(g.satisfied, true);
  assert.match(g.evidence, /^Correct\./, 'credited to the rep turn, not the customer echo');
});
