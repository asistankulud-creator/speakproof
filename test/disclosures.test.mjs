import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DisclosureTracker, SCENARIOS, matchesDisclosure, normalize } from '../src/disclosures.mjs';

const scenario = SCENARIOS.investment_suitability;
const newTracker = () => new DisclosureTracker(scenario.disclosures);

test('normalize strips punctuation and casing', () => {
  assert.equal(normalize('  Past PERFORMANCE, does not...  guarantee!  '), 'past performance does not guarantee');
});

test('a spoken disclosure is detected', () => {
  const t = newTracker();
  const newly = t.ingest('Just so you know, past performance does not guarantee future results.');
  assert.deepEqual(newly, ['no_guarantee']);
  assert.equal(t.satisfied.has('no_guarantee'), true);
});

test('inverted phrasing does NOT satisfy the disclosure', () => {
  // The failure mode that matters: a rep saying the opposite must not tick the box.
  const t = newTracker();
  t.ingest('Honestly, these returns are guaranteed.');
  assert.equal(t.satisfied.has('no_guarantee'), false);
  assert.equal(t.missing.some((d) => d.id === 'no_guarantee'), true);
});

test('customer speech cannot satisfy a rep disclosure', () => {
  const t = newTracker();
  const newly = t.ingest('So past performance does not guarantee anything?', { speaker: 'customer' });
  assert.deepEqual(newly, []);
  assert.equal(t.satisfied.size, 0);
});

test('multiple disclosures accumulate across turns and complete', () => {
  const t = newTracker();
  t.ingest('This call is recorded for quality.');
  t.ingest('Past performance does not guarantee future results.');
  t.ingest('You could lose principal.');
  t.ingest('It is not FDIC insured.');
  assert.equal(t.complete, false, 'still missing the advisory fee');
  t.ingest('Our advisory fee is 0.8 percent annually.');
  assert.equal(t.complete, true);
  const status = t.status();
  assert.equal(status.items.every((i) => i.satisfied), true);
  assert.equal(status.items.find((i) => i.id === 'fees').evidence.includes('0.8'), true);
});

test('a disclosure is not re-reported once satisfied', () => {
  const t = newTracker();
  assert.deepEqual(t.ingest('You could lose principal.'), ['risk_of_loss']);
  assert.deepEqual(t.ingest('Again, you could lose principal.'), []);
});

test('cue groups require every term present', () => {
  const d = { id: 'x', label: 'x', anyOf: [['not', 'fdic']] };
  assert.equal(matchesDisclosure(d, normalize('this is not FDIC insured')), true);
  assert.equal(matchesDisclosure(d, normalize('this is FDIC insured')), false);
});

test('status is serializable and audit-ready', () => {
  const t = newTracker();
  t.ingest('This call is recorded.', { at: 1234 });
  const item = t.status().items.find((i) => i.id === 'recording_notice');
  assert.equal(item.satisfied, true);
  assert.equal(item.at, 1234);
  assert.equal(typeof item.evidence, 'string');
  assert.doesNotThrow(() => JSON.stringify(t.status()));
});
