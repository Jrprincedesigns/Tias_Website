import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from 'react-router';
import { useLoaderData, useNavigation, Form, data as routerData } from 'react-router';
import { boundary } from '@shopify/shopify-app-react-router/server';
import { authenticate } from '../shopify.server';
import pool from '../db.server.ts';
import { advanceStatus, getWorkOrder, listEvents, saveStaffNotes } from '../lib/db.ts';
import { nextStatuses, type ServiceStatus } from '../lib/service-status.ts';

/** Statuses read to a person, not to a database. */
const LABELS: Record<ServiceStatus, string> = {
  requested: 'Requested',
  awaiting_shipment: 'Awaiting shipment',
  in_transit_to_studio: 'In transit to studio',
  received: 'Received',
  inspection: 'Inspection',
  awaiting_customer_approval: 'Awaiting customer approval',
  approved: 'Approved',
  in_service: 'In service',
  quality_check: 'Quality check',
  ready_to_ship: 'Ready to ship',
  return_shipment: 'Return shipment',
  delivered: 'Delivered',
  completed: 'Completed',
  cancelled: 'Cancelled',
  returned_unserviced: 'Returned unserviced',
};

const label = (status: ServiceStatus) => LABELS[status] ?? status;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const id = params.id!;

  try {
    const order = await getWorkOrder(pool, id);
    if (!order) return { ok: true as const, order: null, events: [], moves: [] };

    const events = await listEvents(pool, id);

    return {
      ok: true as const,
      order: {
        ...order,
        submittedAt: order.submittedAt.toISOString(),
        receivedAt: order.receivedAt?.toISOString() ?? null,
        completedAt: order.completedAt?.toISOString() ?? null,
      },
      events: events.map((event) => ({
        ...event,
        createdAt: event.createdAt.toISOString(),
      })),
      // Only the moves the graph actually permits. An illegal transition is
      // never offered, rather than offered and then refused.
      moves: nextStatuses(order.status).map((status) => ({ status, label: label(status) })),
    };
  } catch (error) {
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : 'Unknown database error',
      order: null,
      events: [],
      moves: [],
    };
  }
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const id = params.id!;
  const form = await request.formData();
  const intent = String(form.get('intent'));

  // Who did it, for the audit trail. Online sessions carry the staff member's
  // email; offline ones only know the shop. The app installs with an offline
  // token, so most of the time this records the shop — good enough to
  // distinguish staff action from an automated one, and it improves for free
  // if the app ever moves to online tokens.
  const actor = session.onlineAccessInfo?.associated_user?.email ?? session.shop;

  try {
    if (intent === 'advance') {
      const to = String(form.get('to'));
      const note = String(form.get('note') ?? '').trim();
      const result = await advanceStatus(pool, {
        serviceRequestId: id,
        to,
        actor,
        ...(note ? { note } : {}),
      });
      return routerData({
        ok: true,
        message: result.allowanceSpent
          ? `Moved to ${label(result.to)}. One included service used.`
          : `Moved to ${label(result.to)}.`,
      });
    }

    if (intent === 'notes') {
      await saveStaffNotes(pool, {
        serviceRequestId: id,
        notes: String(form.get('staffNotes') ?? ''),
        actor,
      });
      return routerData({ ok: true, message: 'Notes saved.' });
    }

    return routerData({ ok: false, message: `Unknown action: ${intent}` }, { status: 400 });
  } catch (error) {
    // A refused transition or an uncovered allowance is a real answer, not a
    // crash — Tia needs to read why rather than see a stack trace.
    return routerData(
      { ok: false, message: error instanceof Error ? error.message : 'Something went wrong' },
      { status: 200 },
    );
  }
};

export default function WorkOrderDetail() {
  const data = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const busy = navigation.state !== 'idle';

  if (!data.ok) {
    return (
      <s-page heading="Work order">
        <s-section heading="Can't reach the database">
          <s-paragraph>{data.message}</s-paragraph>
        </s-section>
      </s-page>
    );
  }

  const order = data.order;
  if (!order) {
    return (
      <s-page heading="Work order">
        <s-section heading="Not found">
          <s-paragraph>
            No work order with that id. It may have been removed.
          </s-paragraph>
          <s-link href="/app/orders">Back to work orders</s-link>
        </s-section>
      </s-page>
    );
  }

  const memberName =
    [order.member.firstName, order.member.lastName].filter(Boolean).join(' ') ||
    order.member.email ||
    'Unknown member';

  const spec = [
    order.wig.lengthInches ? `${order.wig.lengthInches}"` : null,
    order.wig.texture,
    order.wig.color,
    order.wig.laceType,
    order.wig.capSize,
  ].filter(Boolean).join(' · ');

  const intakeEntries = Object.entries(order.intake ?? {});

  return (
    <s-page heading={order.wig.nickname}>
      <s-section heading={`${order.serviceType} · ${label(order.status)}`}>
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            <s-text>{memberName}</s-text>
            {order.coveredByAllowance
              ? <s-badge tone="success">Included in membership</s-badge>
              : <s-badge>Paid service</s-badge>}
            {!order.wig.isTCollection ? <s-badge tone="warning">Outside unit</s-badge> : null}
          </s-stack>

          {spec ? <s-text>{spec}</s-text> : null}
          {order.wig.brand ? <s-text>Brand: {order.wig.brand}</s-text> : null}

          {order.membership ? (
            <s-paragraph>
              {order.membership.tier} · {order.membership.allowanceRemaining} service
              {order.membership.allowanceRemaining === 1 ? '' : 's'} remaining
              {order.membership.status !== 'active' ? ` · membership ${order.membership.status}` : ''}
            </s-paragraph>
          ) : (
            <s-paragraph>Not a member — this is a paid service.</s-paragraph>
          )}
        </s-stack>
      </s-section>

      {/* Advancing the work order. Only legal moves appear. */}
      <s-section heading="Move this on">
        {data.moves.length === 0 ? (
          <s-paragraph>This work order is finished. Nothing further to do.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {data.moves.map((move) => (
              <Form method="post" key={move.status}>
                <input type="hidden" name="intent" value="advance" />
                <input type="hidden" name="to" value={move.status} />
                <s-stack direction="inline" gap="base">
                  <s-text-field name="note" label={`Note for "${move.label}"`} />
                  <s-button type="submit" disabled={busy}>{move.label}</s-button>
                </s-stack>
              </Form>
            ))}
            {order.coveredByAllowance && order.status === 'inspection' ? (
              <s-banner tone="info">
                <s-paragraph>
                  Approving spends one of this member's included services.
                </s-paragraph>
              </s-banner>
            ) : null}
          </s-stack>
        )}
      </s-section>

      <s-section heading="What the customer told us">
        {order.customerNotes ? <s-paragraph>{order.customerNotes}</s-paragraph> : null}
        {intakeEntries.length === 0 && !order.customerNotes ? (
          <s-paragraph>Nothing was submitted with this request.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="small-300">
            {intakeEntries.map(([key, value]) => (
              <s-text key={key}>{key}: {String(value)}</s-text>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Studio notes">
        <Form method="post">
          <input type="hidden" name="intent" value="notes" />
          <s-stack direction="block" gap="base">
            <s-text-area
              name="staffNotes"
              label="Notes"
              value={order.staffNotes ?? ''}
              details="Internal. The customer never sees these."
            />
            <s-button type="submit" disabled={busy}>Save notes</s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section slot="aside" heading="History">
        {data.events.length === 0 ? (
          <s-paragraph>Nothing recorded yet.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="small-300">
            {data.events.map((event) => (
              <s-stack key={event.id} direction="block" gap="small-500">
                <s-text>
                  {event.toStatus
                    ? `${event.fromStatus ? label(event.fromStatus) + ' → ' : ''}${label(event.toStatus)}`
                    : event.kind.replace(/_/g, ' ')}
                </s-text>
                <s-text>
                  {new Date(event.createdAt).toLocaleString()} · {event.actor}
                </s-text>
                {event.note ? <s-text>{event.note}</s-text> : null}
              </s-stack>
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(undefined);
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
