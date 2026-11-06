import { describe, expect, it } from 'vitest';
import { renderBigQuerySql, wilson } from '../src/services/analysis.js';
import { classifyGaSource, classifySource } from '../src/services/sources.js';
import { validateEvent } from '../src/services/validation.js';

const now = new Date('2026-11-05T12:00:00Z');
const rules = { now, maxAgeMs: 72 * 3600 * 1000, maxFutureSkewMs: 300 * 1000 };
const valid = {
  event_id: '6b0c1c4e-9a3f-4c1e-8a57-1a2b3c4d5e6f',
  name: 'export',
  anonymous_id: 'abc',
  timestamp: '2026-11-05T11:59:00Z',
  properties: { format: 'quickbooks', rows: 3, real_rows: 2 },
};

describe('classifySource', () => {
  it.each([
    [{ referrerHost: 'www.google.com' }, 'Google'],
    [{ referrerHost: 'www.google.co.uk' }, 'Google'],
    [{ referrerHost: 'mail.google.com' }, 'Email'],
    [{ referrerHost: 'lnkd.in' }, 'LinkedIn'],
    [{ referrerHost: 'www.linkedin.com' }, 'LinkedIn'],
    [{ referrerHost: 'old.reddit.com' }, 'Reddit'],
    [{ referrerHost: 'out.reddit.com' }, 'Reddit'],
    [{ referrerHost: 'news.ycombinator.com' }, 'Hacker News'],
    [{ referrerHost: 't.co' }, 'X'],
    [{ referrerHost: 'someblog.example' }, 'Other'],
    [{ referrerHost: 'notgoogle.com' }, 'Other'],
    [{}, 'Direct'],
    [{ referrerHost: '' }, 'Direct'],
    [{ utmSource: 'LinkedIn', referrerHost: 'www.google.com' }, 'LinkedIn'],
    [{ utmSource: 'reddit.com' }, 'Reddit'],
    [{ utmSource: 'my_newsletter_partner' }, 'Other'],
    [{ utmMedium: 'email' }, 'Email'],
  ])('%j -> %s', (input, expected) => {
    expect(classifySource(input)).toBe(expected);
  });

  it('treats Shoebox itself as Direct', () => {
    expect(classifySource({ referrerHost: 'shoebox.test' }, ['shoebox.test'])).toBe('Direct');
    expect(classifySource({ referrerHost: 'www.shoebox.test' }, ['shoebox.test'])).toBe('Direct');
  });

  it('labels GA4 source names with the same rules', () => {
    expect(classifyGaSource('google')).toBe('Google');
    expect(classifyGaSource('(direct)')).toBe('Direct');
    expect(classifyGaSource('lnkd.in')).toBe('LinkedIn');
    expect(classifyGaSource('reddit.com')).toBe('Reddit');
    expect(classifyGaSource('(not set)')).toBe('(not set)');
  });
});

describe('validateEvent', () => {
  it('accepts a valid export', () => {
    expect(validateEvent(valid, rules).ok).toBe(true);
  });

  it('rejects names outside the tracking plan', () => {
    const r = validateEvent({ ...valid, name: 'exprot' }, rules);
    expect(r).toMatchObject({ ok: false, reason: 'unknown_event' });
  });

  it('enforces per-event properties', () => {
    expect(validateEvent({ ...valid, properties: { format: 'csv', rows: 1, real_rows: 0 } }, rules)).toMatchObject({
      ok: false,
      reason: 'invalid_schema',
    });
    expect(validateEvent({ ...valid, properties: { format: 'full', rows: 1, real_rows: 2 } }, rules)).toMatchObject({
      ok: false,
      reason: 'invalid_schema',
    });
    expect(validateEvent({ ...valid, name: 'upload', properties: undefined }, rules).ok).toBe(false);
    expect(validateEvent({ ...valid, name: 'visit', properties: { x: 1 } }, rules).ok).toBe(false);
  });

  it('rejects unknown top level fields and bad hostnames', () => {
    expect(validateEvent({ ...valid, email: 'a@b.c' }, rules).ok).toBe(false);
    expect(
      validateEvent({ ...valid, name: 'visit', properties: undefined, context: { referrer_host: 'https://x.com/a' } }, rules).ok,
    ).toBe(false);
  });

  it('rejects implausible timestamps', () => {
    expect(validateEvent({ ...valid, timestamp: '2026-11-05T12:10:00Z' }, rules)).toMatchObject({
      reason: 'timestamp_in_future',
    });
    expect(validateEvent({ ...valid, timestamp: '2026-11-01T00:00:00Z' }, rules)).toMatchObject({
      reason: 'timestamp_too_old',
    });
    expect(validateEvent({ ...valid, timestamp: 'yesterday' }, rules)).toMatchObject({ reason: 'invalid_schema' });
  });

  it('rejects oversized events', () => {
    expect(validateEvent({ ...valid, pad: 'x'.repeat(9000) }, rules)).toMatchObject({ reason: 'payload_too_large' });
  });

  it('rejects non-objects without throwing', () => {
    expect(validateEvent(null, rules).ok).toBe(false);
    expect(validateEvent('visit', rules).ok).toBe(false);
    expect(validateEvent([1, 2], rules).ok).toBe(false);
  });
});

describe('wilson', () => {
  it('matches known values', () => {
    const ci = wilson(10, 100);
    expect(ci.low).toBeCloseTo(0.0552, 3);
    expect(ci.high).toBeCloseTo(0.1744, 3);
    expect(wilson(0, 0)).toEqual({ low: 0, high: 0 });
    expect(wilson(5, 5).high).toBe(1);
  });
});

describe('renderBigQuerySql', () => {
  it('inserts a backticked table name', () => {
    expect(renderBigQuerySql('SELECT * FROM {{events_table}}', 'my-proj', 'trailmark', 'events')).toBe(
      'SELECT * FROM `my-proj.trailmark.events`',
    );
  });
  it('refuses identifiers that could inject SQL', () => {
    expect(() => renderBigQuerySql('{{events_table}}', 'p', 'd`; DROP', 'events')).toThrow();
  });
});
