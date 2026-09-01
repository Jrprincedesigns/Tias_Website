/**
 * Validation for the service-request intake form.
 *
 * Everything here arrives from a browser and is therefore a claim, not a fact.
 * Returns all the problems at once rather than the first one, because a form
 * that reveals its objections one at a time is miserable to fill in.
 */

export const SERVICE_TYPES = [
  'rejuvenation',
  'repair',
  'reconstruction',
  'styling',
  'color',
  'other',
] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export interface Intake {
  wigId: string;
  serviceType: ServiceType;
  notes: string | null;
  answers: Record<string, unknown>;
}

export type ParseResult =
  | { ok: true; value: Intake }
  | { ok: false; errors: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Free-text limits. Generous for a person, bounded against a script. */
const MAX_NOTES = 4000;
const MAX_ANSWER_KEYS = 40;
const MAX_ANSWER_LENGTH = 2000;

export function parseIntake(input: unknown): ParseResult {
  const errors: string[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['Body must be a JSON object'] };
  }
  const body = input as Record<string, unknown>;

  const wigId = body.wigId;
  if (typeof wigId !== 'string' || !UUID.test(wigId)) {
    errors.push('wigId must be a uuid');
  }

  const serviceType = body.serviceType;
  if (typeof serviceType !== 'string' || !(SERVICE_TYPES as readonly string[]).includes(serviceType)) {
    errors.push(`serviceType must be one of: ${SERVICE_TYPES.join(', ')}`);
  }

  let notes: string | null = null;
  if (body.notes !== undefined && body.notes !== null) {
    if (typeof body.notes !== 'string') errors.push('notes must be text');
    else if (body.notes.length > MAX_NOTES) errors.push(`notes must be under ${MAX_NOTES} characters`);
    else notes = body.notes.trim() || null;
  }

  const answers: Record<string, unknown> = {};
  if (body.answers !== undefined) {
    if (typeof body.answers !== 'object' || body.answers === null || Array.isArray(body.answers)) {
      errors.push('answers must be an object');
    } else {
      const entries = Object.entries(body.answers as Record<string, unknown>);
      if (entries.length > MAX_ANSWER_KEYS) {
        errors.push(`answers may have at most ${MAX_ANSWER_KEYS} fields`);
      } else {
        for (const [key, value] of entries) {
          // Only scalars. Nested structures in a jsonb blob are a place for
          // surprises to hide, and the form has no need of them.
          if (typeof value === 'string') {
            if (value.length > MAX_ANSWER_LENGTH) {
              errors.push(`answer "${key}" is too long`);
              continue;
            }
            answers[key] = value;
          } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
            answers[key] = value;
          } else {
            errors.push(`answer "${key}" must be text, a number, or true/false`);
          }
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      wigId: wigId as string,
      serviceType: serviceType as ServiceType,
      notes,
      answers,
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Registering a unit                                                        */
/* ------------------------------------------------------------------------- */

export interface WigRegistration {
  nickname: string;
  isTCollection: boolean;
  brand: string | null;
  lengthInches: number | null;
  texture: string | null;
  color: string | null;
  laceType: string | null;
  capSize: string | null;
  notes: string | null;
}

export type WigParseResult =
  | { ok: true; value: WigRegistration }
  | { ok: false; errors: string[] };

const MAX_NICKNAME = 80;
const MAX_SHORT_FIELD = 120;

/** Optional free text: absent, empty and whitespace all collapse to null. */
function optionalText(
  value: unknown,
  field: string,
  max: number,
  errors: string[],
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    errors.push(`${field} must be text`);
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) {
    errors.push(`${field} must be under ${max} characters`);
    return null;
  }
  return trimmed;
}

export function parseWigRegistration(input: unknown): WigParseResult {
  const errors: string[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['Body must be a JSON object'] };
  }
  const body = input as Record<string, unknown>;

  // The nickname is the only thing genuinely required — it is what a member
  // calls the unit and what Tia sees in her queue. Everything else can be
  // filled in later, and demanding it up front is how a form gets abandoned.
  const nickname = optionalText(body.nickname, 'nickname', MAX_NICKNAME, errors);
  if (!nickname) errors.push('Give the unit a name so you can tell it apart');

  let lengthInches: number | null = null;
  if (body.lengthInches !== undefined && body.lengthInches !== null && body.lengthInches !== '') {
    const parsed = Number(body.lengthInches);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      errors.push('Length must be a whole number of inches');
    } else if (parsed < 1 || parsed > 60) {
      // Mirrors the wig_length_sane constraint, so an obvious typo is caught
      // here with a readable sentence rather than as a constraint violation.
      errors.push('Length must be between 1 and 60 inches');
    } else {
      lengthInches = parsed;
    }
  }

  const value: WigRegistration = {
    nickname: nickname ?? '',
    isTCollection: body.isTCollection === true || body.isTCollection === 'true',
    brand: optionalText(body.brand, 'brand', MAX_SHORT_FIELD, errors),
    lengthInches,
    texture: optionalText(body.texture, 'texture', MAX_SHORT_FIELD, errors),
    color: optionalText(body.color, 'color', MAX_SHORT_FIELD, errors),
    laceType: optionalText(body.laceType, 'lace type', MAX_SHORT_FIELD, errors),
    capSize: optionalText(body.capSize, 'cap size', MAX_SHORT_FIELD, errors),
    notes: optionalText(body.notes, 'notes', 2000, errors),
  };

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value };
}

/* ------------------------------------------------------------------------- */
/* Photo uploads                                                             */
/* ------------------------------------------------------------------------- */

/** Extensions the storage bucket accepts, mapped from what a browser sends. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export type UploadRequestResult =
  | { ok: true; value: { extension: string; contentType: string } }
  | { ok: false; errors: string[] };

/**
 * Validates an upload request before a signed URL is minted.
 *
 * Checked here as well as in the bucket because a rejection at this point can
 * explain itself; a rejection at the storage layer arrives as an opaque failure
 * after the member has already waited for the file to transfer.
 */
export function parseUploadRequest(input: unknown): UploadRequestResult {
  const errors: string[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['Body must be a JSON object'] };
  }
  const body = input as Record<string, unknown>;

  const contentType = typeof body.contentType === 'string' ? body.contentType.toLowerCase() : '';
  const extension = IMAGE_EXTENSIONS[contentType];
  if (!extension) {
    errors.push('Photos must be JPEG, PNG, WebP or HEIC');
  }

  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0) {
    errors.push('Could not read the size of that file');
  } else if (size > MAX_UPLOAD_BYTES) {
    errors.push('Photos must be under 20MB');
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { extension: extension!, contentType } };
}
