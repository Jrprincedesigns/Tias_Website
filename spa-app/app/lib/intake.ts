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
