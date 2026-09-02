import type { HeadersFunction, LoaderFunctionArgs } from 'react-router';
import { useLoaderData } from 'react-router';
import { boundary } from '@shopify/shopify-app-react-router/server';
import { authenticate } from '../shopify.server';
import { listOpenWorkOrders } from '../lib/db.ts';
import pool from '../db.server.ts';
import { buildQueue, staleAfterDays, waitingFor } from '../lib/work-queue.ts';

/**
 * The Wig Spa work queue.
 *
 * Grouped by what it asks of Tia rather than listed by status — the question
 * on opening this is "what do I do next", and a flat table answers a different
 * one.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  // The queue is scoped to the store Tia is signed into. Without this it
  // lists every open work order in the database, which on a second install
  // means another store's units appear in hers.
  const { session } = await authenticate.admin(request);

  const threshold = staleAfterDays();
  const now = new Date();

  // A missing or wrong DATABASE_URL should read as a setup problem, not as an
  // empty studio. "No work orders" and "cannot reach the database" look
  // identical otherwise, and one of them is a lie.
  try {
    const open = await listOpenWorkOrders(pool, session.shop);
    const queue = buildQueue(open, now, threshold);

    return {
      ok: true as const,
      threshold,
      totalOpen: queue.totalOpen,
      totalStale: queue.totalStale,
      buckets: queue.buckets.map((bucket) => ({
        key: bucket.key,
        title: bucket.title,
        waitingOnOthers: bucket.waitingOnOthers,
        staleCount: bucket.staleCount,
        items: bucket.items.map((item) => ({
          id: item.id,
          wigNickname: item.wigNickname,
          serviceType: item.serviceType,
          coveredByAllowance: item.coveredByAllowance,
          waiting: waitingFor(item, now),
          stale: bucket.items.indexOf(item) < bucket.staleCount,
        })),
      })),
    };
  } catch (error) {
    return {
      ok: false as const,
      threshold,
      message: error instanceof Error ? error.message : 'Unknown database error',
      totalOpen: 0,
      totalStale: 0,
      buckets: [],
    };
  }
};

export default function WorkQueue() {
  const data = useLoaderData<typeof loader>();

  if (!data.ok) {
    return (
      <s-page heading="The Wig Spa">
        <s-section heading="Can't reach the database">
          <s-paragraph>
            The app is running but could not read the work queue. This is almost always{' '}
            <s-text>DATABASE_URL</s-text> — unset, or pointed at direct Postgres rather than the
            Supabase pooler on port 6543.
          </s-paragraph>
          <s-paragraph>
            <s-text>{data.message}</s-text>
          </s-paragraph>
        </s-section>
      </s-page>
    );
  }

  if (data.totalOpen === 0) {
    return (
      <s-page heading="The Wig Spa">
        <s-section heading="Nothing in the studio">
          <s-paragraph>
            No open work orders. When a member sends a unit in, it appears here.
          </s-paragraph>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="The Wig Spa">
      <s-section heading={summary(data.totalOpen, data.totalStale, data.threshold)}>
        {data.totalStale > 0 ? (
          <s-banner tone="warning">
            <s-paragraph>
              {data.totalStale} {data.totalStale === 1 ? 'unit has' : 'units have'} sat in the same
              stage for {data.threshold}+ days.
            </s-paragraph>
          </s-banner>
        ) : null}
      </s-section>

      {data.buckets.map((bucket) => (
        <s-section key={bucket.key} heading={bucket.title}>
          <s-stack direction="block" gap="base">
            {bucket.waitingOnOthers ? (
              <s-text>Waiting on someone else — nothing for you to do unless it has stalled.</s-text>
            ) : null}

            {bucket.items.map((item) => (
              <s-stack key={item.id} direction="inline" gap="base">
                <s-link href={`/app/orders/${item.id}`}>{item.wigNickname}</s-link>
                <s-text>{item.serviceType}</s-text>
                <s-badge tone={item.stale ? 'warning' : 'info'}>{item.waiting}</s-badge>
                {item.coveredByAllowance ? <s-badge tone="success">included</s-badge> : null}
              </s-stack>
            ))}
          </s-stack>
        </s-section>
      ))}
    </s-page>
  );
}

function summary(open: number, stale: number, threshold: number): string {
  const units = `${open} ${open === 1 ? 'unit' : 'units'} in progress`;
  return stale > 0 ? `${units} · ${stale} waiting ${threshold}+ days` : units;
}

export function ErrorBoundary() {
  return boundary.error(undefined);
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
