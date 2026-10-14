import { describe, it, expect } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { z } from 'zod';
import { withErrorHandling } from '@/lib/ai-response';

// The connection-refused fixtures mirror what the template's own `db` client
// (drizzle-orm + @neondatabase/serverless) throws when the database is unreachable.

const throwing = (error: unknown) =>
  withErrorHandling(() => Promise.reject(error as Error));

const refusedSocket = (address: string) =>
  Object.assign(new Error(`connect ECONNREFUSED ${address}`), {
    code: 'ECONNREFUSED',
  });

const dualStackRefusal = () =>
  Object.assign(
    new AggregateError(
      [refusedSocket('::1:443'), refusedSocket('127.0.0.1:443')],
      ''
    ),
    { code: 'ECONNREFUSED' }
  );

describe('withErrorHandling — database connection refused', () => {
  it('returns 503 for a drizzle query wrapping a WebSocket connection refusal', async () => {
    const wsErrorEvent = { type: 'error', message: '', error: dualStackRefusal() };
    const error = new DrizzleQueryError('select 1', [], wsErrorEvent as unknown as Error);

    const res = await throwing(error)();

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      success: false,
      error: 'Database connection failed',
    });
  });

  it('returns 503 for a bare AggregateError with an empty message', async () => {
    const res = await throwing(dualStackRefusal())();
    expect(res.status).toBe(503);
  });

  it('returns 503 when the refusal is only in a nested errors[] entry', async () => {
    const error = new Error('Failed query: select 1', {
      cause: new AggregateError([refusedSocket('127.0.0.1:5432')], ''),
    });
    const res = await throwing(error)();
    expect(res.status).toBe(503);
  });

  it('still returns 503 when ECONNREFUSED is in the top-level message', async () => {
    const res = await throwing(new Error('connect ECONNREFUSED 127.0.0.1:5432'))();
    expect(res.status).toBe(503);
  });
});

describe('withErrorHandling — other errors are unchanged', () => {
  it('returns 500 for an unrelated wrapped error', async () => {
    const error = new DrizzleQueryError(
      'select 1',
      [],
      Object.assign(new Error('relation "users" does not exist'), { code: '42P01' })
    );
    const res = await throwing(error)();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'Internal server error' });
  });

  it('does not loop forever on a self-referencing cause chain', async () => {
    const error = new Error('boom');
    (error as Error & { cause?: unknown }).cause = error;
    const res = await throwing(error)();
    expect(res.status).toBe(500);
  });

  it('returns 400 for a ZodError', async () => {
    const result = z.object({ name: z.string() }).safeParse({});
    const res = await throwing(result.error)();
    expect(res.status).toBe(400);
  });

  it('returns 501 for a not-yet-implemented error', async () => {
    const res = await throwing(new Error('Export is not yet implemented'))();
    expect(res.status).toBe(501);
  });

  it('returns 500 for a non-Error throw', async () => {
    const res = await throwing('nope')();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'Unknown error occurred' });
  });

  it('passes a successful response through untouched', async () => {
    const handler = withErrorHandling(() => Promise.resolve(Response.json({ ok: true }, { status: 201 })));
    const res = await handler();
    expect(res.status).toBe(201);
  });
});
