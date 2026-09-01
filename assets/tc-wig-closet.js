/**
 * The Wig Closet.
 *
 * Fetches the member's closet from the app proxy and renders it. Shopify signs
 * the request and attaches the customer id on the way through, so nothing here
 * sends or trusts an identity — the page cannot ask for someone else's closet
 * even if a visitor edits it.
 *
 * Three outcomes are kept visually distinct on purpose. An empty closet and a
 * failed request look identical if you let them, and telling a member their
 * wigs are gone when the network hiccuped is the worst version of this page.
 */
(function () {
  'use strict';

  var root = document.querySelector('[data-tc-closet]');
  if (!root) return;

  var base = root.getAttribute('data-proxy-base') || '/apps/spa';
  var serviceUrl = root.getAttribute('data-service-url') || '';
  var membershipUrl = root.getAttribute('data-membership-url') || '';

  /** The §9 ladder, in the order a member experiences it. */
  var TIMELINE = [
    { key: 'awaiting_shipment', label: 'Awaiting shipment' },
    { key: 'in_transit_to_studio', label: 'On its way to us' },
    { key: 'received', label: 'Arrived' },
    { key: 'inspection', label: 'Inspection' },
    { key: 'in_service', label: 'In the spa' },
    { key: 'quality_check', label: 'Quality check' },
    { key: 'return_shipment', label: 'On its way home' },
    { key: 'delivered', label: 'Delivered' }
  ];

  // Statuses that sit outside the straight line and deserve their own wording.
  var ASIDES = {
    requested: 'Requested — not sent yet',
    awaiting_customer_approval: 'Waiting on your approval',
    approved: 'Approved',
    ready_to_ship: 'Ready to ship home',
    returned_unserviced: 'Returning unserviced',
    completed: 'Completed',
    cancelled: 'Cancelled'
  };

  function show(state) {
    root.querySelectorAll('[data-closet-state]').forEach(function (node) {
      node.hidden = node.getAttribute('data-closet-state') !== state;
    });
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /** Escapes by construction — everything goes through textContent. */
  function fail(message) {
    var target = root.querySelector('[data-closet-error]');
    if (target && message) target.textContent = message;
    show('failed');
  }

  function formatDate(iso) {
    if (!iso) return null;
    var date = new Date(iso);
    if (isNaN(date.getTime())) return null;
    return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  function renderMembership(data) {
    var host = root.querySelector('[data-closet-membership]');
    host.textContent = '';

    var card = el('div', 'tc-closet-card tc-closet-membership');

    if (!data.membership) {
      card.appendChild(el('div', 'tc-closet-card__label', 'Membership'));
      card.appendChild(el('p', 'tc-closet-card__body',
        'You are not a member yet. Members get included spa services, member rates, and priority in the studio.'));
      if (membershipUrl) {
        var join = el('a', 'tc-btn tc-btn--outline', 'See membership');
        join.href = membershipUrl;
        card.appendChild(join);
      }
      host.appendChild(card);
      return;
    }

    var m = data.membership;
    card.appendChild(el('div', 'tc-closet-card__label', 'Membership'));
    card.appendChild(el('div', 'tc-closet-membership__tier', m.tier));

    // Anything but active is stated plainly. A member whose payment failed
    // needs to know that before they post a unit expecting it to be covered.
    if (m.status !== 'active') {
      var warn = el('div', 'tc-closet-flag', statusSentence(m.status));
      card.appendChild(warn);
    }

    var remaining = typeof m.servicesRemaining === 'number' ? m.servicesRemaining : 0;
    card.appendChild(el('div', 'tc-closet-membership__count',
      remaining + (remaining === 1 ? ' service remaining' : ' services remaining')));

    var renews = formatDate(m.renewsOn);
    if (renews) card.appendChild(el('div', 'tc-closet-card__meta', 'Renews ' + renews));

    host.appendChild(card);
  }

  function statusSentence(status) {
    if (status === 'past_due') return 'Payment is past due — new services are paused until it clears.';
    if (status === 'paused') return 'Your membership is paused.';
    if (status === 'cancelled') return 'Your membership is cancelled.';
    if (status === 'expired') return 'Your membership has expired.';
    return 'Your membership is not currently active.';
  }

  function renderTimeline(status) {
    var wrap = el('div', 'tc-closet-timeline');
    var currentIndex = TIMELINE.findIndex(function (step) { return step.key === status; });

    if (currentIndex === -1) {
      // An aside status — show the sentence rather than a misleading position
      // on a line it does not sit on.
      wrap.appendChild(el('div', 'tc-closet-flag', ASIDES[status] || status));
      return wrap;
    }

    TIMELINE.forEach(function (step, index) {
      var state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo';
      var node = el('div', 'tc-closet-step tc-closet-step--' + state);
      node.appendChild(el('span', 'tc-closet-step__dot'));
      node.appendChild(el('span', 'tc-closet-step__label', step.label));
      wrap.appendChild(node);
    });
    return wrap;
  }

  function renderActive(data) {
    var host = root.querySelector('[data-closet-active]');
    host.textContent = '';
    if (!data.activeServices || data.activeServices.length === 0) return;

    host.appendChild(el('h2', 'tc-closet-heading', 'In progress'));

    data.activeServices.forEach(function (service) {
      var card = el('div', 'tc-closet-card');
      var head = el('div', 'tc-closet-card__head');
      head.appendChild(el('div', 'tc-closet-card__title', service.wigNickname));
      head.appendChild(el('div', 'tc-closet-card__label', service.serviceType));
      if (service.coveredByAllowance) {
        head.appendChild(el('span', 'tc-closet-chip', 'Included'));
      }
      card.appendChild(head);
      card.appendChild(renderTimeline(service.status));
      host.appendChild(card);
    });
  }

  function renderWigs(data) {
    var host = root.querySelector('[data-closet-wigs]');
    host.textContent = '';
    host.appendChild(el('h2', 'tc-closet-heading', 'Your units'));

    if (!data.wigs || data.wigs.length === 0) {
      var empty = el('div', 'tc-closet-card tc-closet-empty');
      empty.appendChild(el('p', 'tc-closet-card__body',
        'No units registered yet. Add one and every service we do to it is recorded against it from then on.'));
      if (serviceUrl) {
        var add = el('a', 'tc-btn tc-btn--dark', 'Send a wig in');
        add.href = serviceUrl;
        empty.appendChild(add);
      }
      host.appendChild(empty);
      return;
    }

    var grid = el('div', 'tc-closet-grid');
    data.wigs.forEach(function (wig) {
      var card = el('div', 'tc-closet-card tc-closet-wig');
      card.appendChild(el('div', 'tc-closet-card__title', wig.nickname));

      var spec = [wig.lengthInches ? wig.lengthInches + '"' : null, wig.texture, wig.color]
        .filter(Boolean).join(' · ');
      if (spec) card.appendChild(el('div', 'tc-closet-card__label', spec));

      var serviced = formatDate(wig.lastServicedAt);
      card.appendChild(el('div', 'tc-closet-card__meta',
        serviced ? 'Last serviced ' + serviced : 'Never serviced'));

      if (!wig.isTCollection) card.appendChild(el('span', 'tc-closet-chip', 'Outside unit'));
      grid.appendChild(card);
    });
    host.appendChild(grid);

    if (serviceUrl) {
      var cta = el('a', 'tc-btn tc-btn--dark tc-closet-cta', 'Send a wig in');
      cta.href = serviceUrl;
      host.appendChild(cta);
    }
  }

  fetch(base + '/closet', {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin'
  })
    .then(function (response) {
      return response.text().then(function (text) {
        var data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          // Shopify's proxy replaces the body of any non-2xx response with its
          // own HTML error page, so unreadable text means the app is down or
          // unreachable rather than that it sent something strange.
          throw new Error('We could not reach the studio. Please try again shortly.');
        }
        // The endpoint always answers 200 and puts the outcome in the body,
        // precisely so this message survives the trip.
        if (data.ok === false) {
          throw new Error(data.error === 'app_misconfigured'
            ? 'The studio service is not configured correctly. We have been notified.'
            : 'The studio service is temporarily unavailable.');
        }
        if (data.signedIn === false) {
          throw new Error('Your session expired. Sign in again to see your closet.');
        }
        return data;
      });
    })
    .then(function (data) {
      renderMembership(data);
      renderActive(data);
      renderWigs(data);
      show('ready');
    })
    .catch(function (error) {
      fail(error && error.message);
    });
})();
