import type { HeadersFunction, LoaderFunctionArgs } from 'react-router';
import { useLoaderData } from 'react-router';
import { boundary } from '@shopify/shopify-app-react-router/server';
import { authenticate } from '../shopify.server';
import pool from '../db.server.ts';
import type { ServiceStatus } from '../lib/service-status.ts';

/**
 * Every work order, open and closed.
 *
 * The home screen is deliberately only what needs Tia today, which means
 * finished work would otherwise be unreachable. This is where you go looking
 * for "that wig we did in March".
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  try {
    const { rows } = await pool.query(
      `select sr.id, sr.status, sr.service_type, sr.covered_by_allowance, sr.submitted_at,
              w.nickname, m.first_name, m.last_name, m.email
         from service_requests sr
         join wigs w    on w.id = sr.wig_id
         join members m on m.id = sr.member_id
        order by sr.submitted_at desc
        limit 200`,
    );

    return {
      ok: true as const,
      orders: rows.map((row) => ({
        id: row.id as string,
        status: row.status as ServiceStatus,
        serviceType: row.service_type as string,
        covered: row.covered_by_allowance as boolean,
        wigNickname: row.nickname as string,
        member: [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email || 'Unknown',
        submitted: new Date(row.submitted_at).toLocaleDateString(undefined, {
          day: 'numeric', month: 'short', year: 'numeric',
        }),
      })),
    };
  } catch (error) {
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : 'Unknown database error',
      orders: [],
    };
  }
};

export default function WorkOrders() {
  const data = useLoaderData<typeof loader>();

  if (!data.ok) {
    return (
      <s-page heading="Work orders">
        <s-section heading="Can't reach the database">
          <s-paragraph>{data.message}</s-paragraph>
        </s-section>
      </s-page>
    );
  }

  if (data.orders.length === 0) {
    return (
      <s-page heading="Work orders">
        <s-section heading="Nothing here yet">
          <s-paragraph>Work orders appear when a member sends a unit in.</s-paragraph>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Work orders">
      <s-section heading={`${data.orders.length} total`}>
        <s-stack direction="block" gap="base">
          {data.orders.map((order) => (
            <s-stack key={order.id} direction="inline" gap="base">
              <s-link href={`/app/orders/${order.id}`}>{order.wigNickname}</s-link>
              <s-text>{order.member}</s-text>
              <s-text>{order.serviceType}</s-text>
              <s-badge>{order.status.replace(/_/g, ' ')}</s-badge>
              {order.covered ? <s-badge tone="success">included</s-badge> : null}
              <s-text>{order.submitted}</s-text>
            </s-stack>
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(undefined);
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
