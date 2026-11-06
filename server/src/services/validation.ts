import { z } from 'zod';

export const MAX_EVENT_BYTES = 8 * 1024;

/** The Shoebox tracking plan. Anything else is rejected so typos never reach the reports. */
export const EVENT_NAMES = ['visit', 'upload', 'upload_failed', 'export'] as const;
export type EventName = (typeof EVENT_NAMES)[number];

const optionalTag = z.string().trim().min(1).max(200).optional();

const context = z
  .object({
    page_path: z.string().startsWith('/').max(1024).optional(),
    referrer_host: z
      .string()
      .max(253)
      .regex(/^[a-z0-9.-]+$/i, 'referrer_host must be a bare hostname')
      .optional(),
    utm_source: optionalTag,
    utm_medium: optionalTag,
    utm_campaign: optionalTag,
  })
  .strict();

const base = {
  event_id: z.string().uuid('event_id must be a UUID'),
  anonymous_id: z.string().min(1).max(128),
  timestamp: z.string().datetime({ offset: true, message: 'timestamp must be an ISO 8601 date-time' }),
  context: context.optional(),
};

const count = z.number().int().min(0).max(10_000);

export const incomingEventSchema = z.discriminatedUnion(
  'name',
  [
    z.object({ ...base, name: z.literal('visit'), properties: z.object({}).strict().optional() }).strict(),
    z
      .object({
        ...base,
        name: z.literal('upload'),
        properties: z.object({ sample: z.boolean(), file_type: z.enum(['image', 'pdf']) }).strict(),
      })
      .strict(),
    z
      .object({
        ...base,
        name: z.literal('upload_failed'),
        properties: z.object({ sample: z.boolean(), error: z.string().max(200) }).strict(),
      })
      .strict(),
    z
      .object({
        ...base,
        name: z.literal('export'),
        properties: z
          .object({ format: z.enum(['quickbooks', 'full']), rows: count, real_rows: count })
          .strict()
          .refine((p) => p.real_rows <= p.rows, { message: 'real_rows cannot exceed rows', path: ['real_rows'] }),
      })
      .strict(),
  ],
  // name is checked against EVENT_NAMES before parsing, so the discriminator error never surfaces.
);

export type IncomingEvent = z.infer<typeof incomingEventSchema>;

export type RejectionReason =
  | 'unknown_event'
  | 'invalid_schema'
  | 'payload_too_large'
  | 'timestamp_in_future'
  | 'timestamp_too_old';

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; event: IncomingEvent; occurredAt: Date }
  | { ok: false; reason: RejectionReason; issues: ValidationIssue[] };

export interface TimeRules {
  now: Date;
  maxAgeMs: number;
  maxFutureSkewMs: number;
}

/** Validates one raw event: size, tracking plan, shape, then timestamp plausibility. */
export function validateEvent(raw: unknown, rules: TimeRules): ValidationResult {
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(raw) ?? '', 'utf8');
  } catch {
    return { ok: false, reason: 'invalid_schema', issues: [{ path: '', message: 'event is not serializable' }] };
  }
  if (size > MAX_EVENT_BYTES) {
    return {
      ok: false,
      reason: 'payload_too_large',
      issues: [{ path: '', message: `event is ${size} bytes, limit is ${MAX_EVENT_BYTES}` }],
    };
  }

  const name = (raw as { name?: unknown } | null)?.name;
  if (typeof name !== 'string' || !(EVENT_NAMES as readonly string[]).includes(name)) {
    return {
      ok: false,
      reason: 'unknown_event',
      issues: [{ path: 'name', message: `name must be one of: ${EVENT_NAMES.join(', ')}` }],
    };
  }

  const parsed = incomingEventSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'invalid_schema',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }

  const occurredAt = new Date(parsed.data.timestamp);
  const nowMs = rules.now.getTime();
  if (occurredAt.getTime() > nowMs + rules.maxFutureSkewMs) {
    return {
      ok: false,
      reason: 'timestamp_in_future',
      issues: [{ path: 'timestamp', message: `timestamp is more than ${rules.maxFutureSkewMs / 1000}s ahead of server time` }],
    };
  }
  if (occurredAt.getTime() < nowMs - rules.maxAgeMs) {
    return {
      ok: false,
      reason: 'timestamp_too_old',
      issues: [{ path: 'timestamp', message: `timestamp is older than ${rules.maxAgeMs / 3_600_000}h` }],
    };
  }

  return { ok: true, event: parsed.data, occurredAt };
}
