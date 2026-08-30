import type { ActionFunctionArgs } from 'react-router';
import pool from '../db.server.ts';
import { findOrCreateMember } from '../lib/db.ts';
import { parseUploadRequest } from '../lib/intake.ts';
import { json, proxyError, withProxyAuth } from '../lib/proxy.ts';
import { createUploadTicket } from '../lib/storage.ts';

/**
 * POST /apps/spa/upload-url — a ticket to upload one photograph.
 *
 * The browser sends only the file's type and size; the path is generated
 * server-side under the member's own prefix, so nobody can choose where their
 * file lands or overwrite another member's. The returned token is good for that
 * one path and nothing else.
 *
 * Type and size are checked before the ticket is issued rather than left to the
 * bucket, because a rejection here can explain itself — a rejection at the
 * storage layer arrives after the member has already waited for the transfer.
 */
export const action = async ({ request }: ActionFunctionArgs) =>
  withProxyAuth(request, async (customer) => {
    if (request.method !== 'POST') return proxyError('method_not_allowed', 405);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return proxyError('invalid_json', 400);
    }

    const parsed = parseUploadRequest(body);
    if (!parsed.ok) {
      return json({ ok: false, error: 'invalid_request', httpStatus: 422, details: parsed.errors });
    }

    const member = await findOrCreateMember(pool, { shopifyCustomerId: customer.shopifyCustomerId });
    const ticket = await createUploadTicket(member.id, parsed.value.extension);

    return json({
      ok: true,
      path: ticket.path,
      token: ticket.token,
      signedUrl: ticket.signedUrl,
      contentType: parsed.value.contentType,
    });
  });
