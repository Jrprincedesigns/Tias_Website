import type { ActionFunctionArgs } from 'react-router';
import { authenticate } from '../shopify.server';
import pool from '../db.server';
import {
  billingAttemptOutcome,
  handleBillingChallenged,
  handleBillingFailure,
  handleBillingSuccess,
} from '../lib/renewal-billing';

/**
 * subscription_billing_attempts/success, /failure and /challenged.
 *
 * The outcome of a renewal charge the daily job sent (cron.billing.ts). A
 * charge is processed asynchronously, so this — not the job — is where a
 * payment is recorded against the membership, the contract's next billing date
 * moves on, and a failure is scheduled for retry or, after the last one, the
 * contract is cancelled. The rules are in renewal-billing.ts.
 *
 * Every handler is safe to receive twice: an outcome already recorded is left
 * alone.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, admin } = await authenticate.webhook(request);
  const outcome = billingAttemptOutcome(payload);

  // Uninstalled between the charge and this delivery. Retrying cannot help.
  if (!admin) {
    console.warn(`[${topic}] ${shop}: no admin client (app uninstalled?), skipping ${outcome.attemptId}`);
    return new Response();
  }

  // SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS, or subscription_billing_attempts/success.
  const kind = topic.toLowerCase();
  let handled;
  if (kind.endsWith('success')) {
    handled = await handleBillingSuccess(pool, admin, outcome);
  } else if (kind.endsWith('failure')) {
    handled = await handleBillingFailure(pool, admin, outcome);
  } else if (kind.endsWith('challenged')) {
    handled = await handleBillingChallenged(pool, admin, outcome);
  } else {
    console.warn(`[${topic}] ${shop}: not a billing attempt outcome, ignored`);
    return new Response();
  }

  console.log(
    `[${topic}] ${shop}: ${outcome.attemptId} on ${outcome.contractId} — ${handled}` +
      (outcome.errorCode ? ` (${outcome.errorCode})` : ''),
  );
  return new Response();
};
