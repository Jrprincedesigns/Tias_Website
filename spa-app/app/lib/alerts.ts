/**
 * Operational alerts.
 *
 * This exists for one failure that is silent by nature: someone uninstalls the
 * app. Shopify deletes an app's selling plan groups roughly two days later, and
 * live memberships depend on them — so there is a window in which reinstalling
 * costs nothing and after which it costs a great deal. The uninstall webhook
 * fires immediately, but until now it only wrote to a log nobody reads, which
 * meant the first sign of trouble would have been a member's card not being
 * charged.
 *
 * Deliberately a plain POST to a URL rather than an email SDK. A Slack or
 * Discord incoming webhook takes it as-is, and so does any automation service
 * that can turn a request into a text message — so where the alert lands is a
 * setting rather than a dependency, and there is no vendor to keep patched for
 * the sake of one message a year.
 *
 * Never throws. An alert that fails must not fail the webhook that raised it:
 * Shopify retries deliveries it considers failed, and a retry storm over an
 * unreachable notifier would be a worse problem than the one being reported.
 */

/** Short. Shopify expects a webhook answered in seconds, not eventually. */
const TIMEOUT_MS = 3000;

export interface Alert {
  /** One line, written to be read on a phone screen. */
  summary: string;
  /** Machine-readable name for whatever raised it, e.g. 'app_uninstalled'. */
  event: string;
  /** Anything worth having in front of you while deciding what to do. */
  detail?: Record<string, unknown>;
}

export async function sendAlert(alert: Alert): Promise<void> {
  // Always log, whether or not a notifier is configured. When someone goes
  // looking afterwards, this is the record.
  console.warn(`[alert] ${alert.event}: ${alert.summary}`, alert.detail ?? {});

  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `text` is what Slack and Discord render. The rest rides alongside for
      // anything parsing the body instead of displaying it.
      body: JSON.stringify({
        text: alert.summary,
        event: alert.event,
        detail: alert.detail ?? {},
        at: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    console.error(
      `[alert] could not deliver ${alert.event}:`,
      cause instanceof Error ? cause.message : cause,
    );
  }
}
