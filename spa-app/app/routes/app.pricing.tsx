import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from 'react-router';
import { Form, useActionData, useLoaderData, useNavigation, useRouteError } from 'react-router';
import { boundary } from '@shopify/shopify-app-react-router/server';
import { authenticate } from '../shopify.server';
import pool from '../db.server.ts';
import { getPricingSettings, listServiceInputs, savePricing } from '../lib/db.ts';
import { money, priceAll } from '../lib/service-pricing.ts';

/**
 * Service pricing.
 *
 * These numbers were worked out once and would otherwise live in a chat log.
 * They move — postage rises, a colour line changes, Tia gets faster — and each
 * of those should be a field she edits rather than a question she has to ask
 * someone. So the inputs are here, and the prices are computed from them every
 * time this page loads.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  try {
    const [settings, services] = await Promise.all([
      getPricingSettings(pool),
      listServiceInputs(pool),
    ]);
    return { ok: true as const, settings, priced: priceAll(services, settings) };
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : String(error) };
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();

  const num = (key: string) => Number(form.get(key));
  const dollarsToCents = (key: string) => Math.round(Number(form.get(key)) * 100);

  const services = form
    .getAll('serviceId')
    .map(String)
    .map((id) => ({
      id,
      hours: Number(form.get(`hours:${id}`)),
      materialsCents: Math.round(Number(form.get(`materials:${id}`)) * 100),
      includesShipping: form.get(`shipping:${id}`) === 'on',
    }));

  // Rejected here rather than by a database constraint, so the message names
  // the thing that is wrong instead of the column that refused it.
  const invalid = services.find((s) => !(s.hours > 0) || !(s.materialsCents >= 0));
  if (invalid) {
    return { ok: false as const, message: 'Hours must be above zero and materials cannot be negative.' };
  }
  if (!(num('ownerDrawPercent') > 0 && num('ownerDrawPercent') <= 100)) {
    return { ok: false as const, message: 'The owner draw must be between 0 and 100 percent.' };
  }

  try {
    await savePricing(pool, {
      settings: {
        ownerDrawPercent: num('ownerDrawPercent'),
        targetHourlyCents: dollarsToCents('targetHourly'),
        processingPercent: num('processingPercent'),
        processingFixedCents: dollarsToCents('processingFixed'),
        shippingCents: dollarsToCents('shipping'),
      },
      services,
    });
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : String(error) };
  }
};

export default function Pricing() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === 'submitting';

  if (!data.ok) {
    return (
      <s-page heading="Service pricing">
        <s-section heading="Can't read the pricing settings">
          <s-paragraph>{data.message}</s-paragraph>
        </s-section>
      </s-page>
    );
  }

  const { settings, priced } = data;

  return (
    <s-page heading="Service pricing">
      <s-section heading="How a price is worked out">
        <s-paragraph>
          Tia takes {settings.ownerDrawPercent}% of every sale. A price is set so that her share
          actually pays for the hours the work takes — so raising the target rate below lifts every
          service at once, and nothing here has to be recalculated by hand.
        </s-paragraph>
        <s-paragraph>
          <s-text>price = hours × target rate ÷ {settings.ownerDrawPercent}%</s-text>
        </s-paragraph>
      </s-section>

      {result?.ok === false && <s-banner tone="critical">{result.message}</s-banner>}
      {result?.ok && <s-banner tone="success">Saved. The prices below are recalculated.</s-banner>}

      <Form method="post">
        <s-section heading="What every service shares">
          <s-text-field label="Tia's share of each sale (%)" name="ownerDrawPercent" defaultValue={String(settings.ownerDrawPercent)} />
          <s-text-field label="Target rate for her time ($ per hour)" name="targetHourly" defaultValue={(settings.targetHourlyCents / 100).toFixed(2)} />
          <s-text-field label="Insured round-trip shipping ($)" name="shipping" defaultValue={(settings.shippingCents / 100).toFixed(2)} />
          <s-text-field label="Card processing (%)" name="processingPercent" defaultValue={String(settings.processingPercent)} />
          <s-text-field label="Card processing, fixed ($)" name="processingFixed" defaultValue={(settings.processingFixedCents / 100).toFixed(2)} />
        </s-section>

        <s-section heading="Each service">
          {priced.map((service) => (
            <s-section key={service.id} heading={`${service.name} — ${money(service.priceCents)}`}>
              <input type="hidden" name="serviceId" value={service.id} />
              <s-text-field label="Hours" name={`hours:${service.id}`} defaultValue={String(service.hours)} />
              <s-text-field label="Materials ($)" name={`materials:${service.id}`} defaultValue={(service.materialsCents / 100).toFixed(2)} />
              <s-checkbox
                label="The studio pays shipping both ways"
                name={`shipping:${service.id}`}
                defaultChecked={service.includesShipping}
              />
              <s-paragraph>
                Tia takes {money(service.drawCents)} — {money(service.effectiveHourlyCents)} an hour.
                Costs {money(service.costCents)}
                {service.includesShipping ? `, of which ${money(service.shippingCents)} is shipping` : ''}.
                The business keeps {money(service.retainedCents)}.
              </s-paragraph>
              {service.underwater && (
                <s-banner tone="critical">
                  This price does not cover its costs and her share. Raise the hours or the target
                  rate, or stop absorbing the shipping.
                </s-banner>
              )}
              {service.notes && <s-paragraph><s-text>{service.notes}</s-text></s-paragraph>}
            </s-section>
          ))}
        </s-section>

        <s-button type="submit" variant="primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save and recalculate'}
        </s-button>
      </Form>

      <s-section heading="Putting these into the shop">
        <s-paragraph>
          Changing a number here does not change what a customer pays. These are the prices the
          services should carry — the products themselves are still edited in Products, on purpose,
          so nothing here can reprice the shop by being saved.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
