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

/* --- registering a unit --------------------------------------------------- */

import { parseWigRegistration, parseUploadRequest, MAX_UPLOAD_BYTES } from '../app/lib/intake.ts';

test('a nickname alone is enough to register a unit', () => {
  // Demanding texture, cap size and lace type up front is how a form gets
  // abandoned. Everything but the name can be filled in later.
  const result = parseWigRegistration({ nickname: 'Chocolate Body Wave' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.nickname, 'Chocolate Body Wave');
  assert.equal(result.value.isTCollection, false);
  assert.equal(result.value.lengthInches, null);
});

test('a unit with no name is refused, in words a person would use', () => {
  const result = parseWigRegistration({ texture: 'body wave' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.errors[0] ?? '', /name/i);
});

test('blank and whitespace-only fields become null, not empty strings', () => {
  const result = parseWigRegistration({ nickname: '  Unit A  ', brand: '   ', texture: '' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.nickname, 'Unit A');
  assert.equal(result.value.brand, null);
  assert.equal(result.value.texture, null);
});

test('length is bounded the same way the database bounds it', () => {
  // Mirrors wig_length_sane so a typo comes back as a sentence rather than a
  // constraint violation.
  assert.equal(parseWigRegistration({ nickname: 'x', lengthInches: 26 }).ok, true);
  assert.equal(parseWigRegistration({ nickname: 'x', lengthInches: 0 }).ok, false);
  assert.equal(parseWigRegistration({ nickname: 'x', lengthInches: 400 }).ok, false);
  assert.equal(parseWigRegistration({ nickname: 'x', lengthInches: 26.5 }).ok, false);
});

test('an empty length is absent, not invalid', () => {
  // An untouched number input submits '' — that must not read as an error.
  const result = parseWigRegistration({ nickname: 'x', lengthInches: '' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.lengthInches, null);
});

test('isTCollection accepts the string a form actually submits', () => {
  assert.equal(parseWigRegistration({ nickname: 'x', isTCollection: 'true' }).ok, true);
  const result = parseWigRegistration({ nickname: 'x', isTCollection: 'true' });
  if (result.ok) assert.equal(result.value.isTCollection, true);
});

/* --- photo uploads -------------------------------------------------------- */

test('every type the bucket accepts is accepted here too', () => {
  for (const [type, ext] of Object.entries({
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/heic': 'heic', 'image/heif': 'heif',
  })) {
    const result = parseUploadRequest({ contentType: type, size: 1024 });
    assert.equal(result.ok, true, `${type} should be allowed`);
    if (result.ok) assert.equal(result.value.extension, ext);
  }
});

test('HEIC is accepted, because iPhones shoot it by default', () => {
  assert.equal(parseUploadRequest({ contentType: 'IMAGE/HEIC', size: 500 }).ok, true,
    'and the content type may arrive in any case');
});

test('a PDF pretending to be a photo is refused', () => {
  const result = parseUploadRequest({ contentType: 'application/pdf', size: 1024 });
  assert.equal(result.ok, false);
});

test('an oversized photo is refused before it is uploaded, not after', () => {
  assert.equal(parseUploadRequest({ contentType: 'image/jpeg', size: MAX_UPLOAD_BYTES + 1 }).ok, false);
  assert.equal(parseUploadRequest({ contentType: 'image/jpeg', size: MAX_UPLOAD_BYTES }).ok, true);
});

test('a file with no readable size is refused', () => {
  assert.equal(parseUploadRequest({ contentType: 'image/jpeg' }).ok, false);
  assert.equal(parseUploadRequest({ contentType: 'image/jpeg', size: 0 }).ok, false);
});
