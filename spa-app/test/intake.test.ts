import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIntake } from '../app/lib/intake.ts';

const WIG = '11111111-2222-3333-4444-555555555555';

test('accepts a well-formed request', () => {
  const result = parseIntake({
    wigId: WIG,
    serviceType: 'rejuvenation',
    notes: '  lace is lifting at the temples  ',
    answers: { desiredPart: 'middle', hasBeenColored: false, wearsPerMonth: 6 },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.notes, 'lace is lifting at the temples', 'notes are trimmed');
  assert.deepEqual(result.value.answers, { desiredPart: 'middle', hasBeenColored: false, wearsPerMonth: 6 });
});

test('reports every problem at once, not just the first', () => {
  const result = parseIntake({ wigId: 'not-a-uuid', serviceType: 'teleportation' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors.length, 2, 'both the id and the service type are reported');
});

test('rejects a non-object body', () => {
  for (const body of ['string', 42, null, [], undefined]) {
    const result = parseIntake(body);
    assert.equal(result.ok, false, `${JSON.stringify(body)} should be rejected`);
  }
});

test('an empty notes field becomes null rather than an empty string', () => {
  const result = parseIntake({ wigId: WIG, serviceType: 'repair', notes: '   ' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.notes, null);
});

test('notes have an upper bound', () => {
  const result = parseIntake({ wigId: WIG, serviceType: 'repair', notes: 'x'.repeat(4001) });
  assert.equal(result.ok, false);
});

test('nested objects are refused inside answers', () => {
  // A jsonb column will happily swallow arbitrary structure; the form has no
  // need of it and it is a good place for surprises to hide.
  const result = parseIntake({
    wigId: WIG, serviceType: 'repair',
    answers: { damage: { lace: 'torn', wefts: ['loose'] } },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.errors[0] ?? '', /must be text, a number, or true\/false/);
});

test('an absurd number of answer fields is refused', () => {
  const answers: Record<string, string> = {};
  for (let i = 0; i < 41; i += 1) answers[`q${i}`] = 'x';
  const result = parseIntake({ wigId: WIG, serviceType: 'repair', answers });
  assert.equal(result.ok, false);
});

test('answers is optional', () => {
  const result = parseIntake({ wigId: WIG, serviceType: 'styling' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.answers, {});
});

test('every advertised service type is accepted', () => {
  for (const serviceType of ['rejuvenation', 'repair', 'reconstruction', 'styling', 'color', 'other']) {
    assert.equal(parseIntake({ wigId: WIG, serviceType }).ok, true, `${serviceType} should be valid`);
  }
});
