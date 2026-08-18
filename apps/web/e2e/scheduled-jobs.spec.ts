import { expect, test } from '@playwright/test';

/**
 * The scheduled-jobs endpoint (ADR-0023).
 *
 * These four jobs used to run on timers inside a process that never exits. No
 * platform gives one of those away, so the timer moved outside and the work
 * stayed here — which turned four internal function calls into a public HTTP
 * surface, and a public HTTP surface is a thing that has to be tested as one.
 *
 * `idor-matrix.spec.ts` covers who is refused. This covers what happens when
 * the caller is the scheduler: that each job actually runs against real
 * Postgres, real Redis and real storage rather than merely returning 200, and
 * that the door is shut in every way it can be shut.
 *
 * `redrive-media` matters most of the four. It is the only thing standing
 * between a failed inline encode and a customer's photograph disappearing, so
 * "it is wired up and answers" is the minimum this file has to prove.
 */

// The value `playwright.config.ts` starts the server with. Not a credential:
// it reaches a loopback server that exists for the length of this run.
const CRON_SECRET = 'e2e-cron-secret-value-at-least-32-characters-long';

const JOBS = ['sweep-media', 'expire-invitations', 'flush-analytics', 'redrive-media'] as const;

test.describe('the scheduled jobs endpoint', () => {
  for (const job of JOBS) {
    test(`runs ${job} and reports what it did`, async ({ request }) => {
      const response = await request.post(`/api/internal/jobs/${job}`, {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      });

      // A 200 here means the job reached its repositories and came back. On an
      // empty-ish database every report is zeroes, and that is the point: the
      // failure this catches is a job that throws on the way to the database,
      // which is what a mis-wired dependency looks like.
      expect(response.status(), await response.text()).toBe(200);
      const body = (await response.json()) as { data?: { job?: string } };
      expect(body.data?.job).toBe(job);
    });
  }

  test('refuses a caller with no token, and does not admit the job exists', async ({ request }) => {
    const response = await request.post('/api/internal/jobs/sweep-media');
    expect(response.status()).toBe(404);
  });

  test('refuses a wrong token', async ({ request }) => {
    const response = await request.post('/api/internal/jobs/sweep-media', {
      headers: { authorization: 'Bearer not-the-secret-but-the-right-length-00' },
    });
    expect(response.status()).toBe(404);
  });

  test('refuses an unknown job name even with the right token', async ({ request }) => {
    // The token authenticates the scheduler; it does not authorise arbitrary
    // work. A job name that does not exist is a 404 like any other, and never
    // a 500 from falling off the end of a switch.
    const response = await request.post('/api/internal/jobs/delete-everything', {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(response.status()).toBe(404);
  });

  test('refuses a cross-site Origin even with the right token', async ({ request }) => {
    const response = await request.post('/api/internal/jobs/sweep-media', {
      headers: {
        authorization: `Bearer ${CRON_SECRET}`,
        origin: 'https://attacker.example',
      },
    });
    expect(response.status()).toBe(403);
  });
});
