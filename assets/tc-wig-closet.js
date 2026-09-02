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

  // Kept so the panel can page through units and show membership context
  // without a second trip to the proxy.
  var closetData = null;
  var panel = null;
  var panelIndex = -1;
  var lastFocused = null;

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

  function formatDay(iso) {
    if (!iso) return null;
    var date = new Date(iso);
    if (isNaN(date.getTime())) return null;
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  }

  /** The member-facing name for a status, wherever it sits on the ladder. */
  function statusLabel(status) {
    for (var i = 0; i < TIMELINE.length; i++) {
      if (TIMELINE[i].key === status) return TIMELINE[i].label;
    }
    return ASIDES[status] || status;
  }

  function specLine(wig) {
    return [wig.lengthInches ? wig.lengthInches + '\"' : null, wig.texture, wig.color]
      .filter(Boolean).join(' \u00b7 ');
  }

  function renderMembership(data) {
    var host = root.querySelector('[data-closet-membership]');
    host.textContent = '';

    var card = el('div', 'tc-closet-card tc-closet-membership');

    if (!data.membership) {
      card.appendChild(el('div', 'tc-closet-card__label', 'Membership'));
      card.appendChild(el('p', 'tc-closet-card__body',
        'You are not a member yet. Members pay less on every service in the spa and move ahead in the studio queue.'));
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

    // What the membership is worth, rather than a countdown. Membership stopped
    // including services, so "3 services remaining" was quietly counting down an
    // allowance that nothing grants any more — it read as a benefit expiring.
    if (typeof m.discountPercent === 'number' && m.discountPercent > 0) {
      card.appendChild(el('div', 'tc-closet-membership__count',
        m.discountPercent + '% off every service in the spa'));
    }

    // Only for members carrying an allowance from the old model. A zero here is
    // the ordinary case now and says nothing worth reading.
    var remaining = typeof m.servicesRemaining === 'number' ? m.servicesRemaining : 0;
    if (remaining > 0) {
      card.appendChild(el('div', 'tc-closet-card__meta',
        remaining + (remaining === 1 ? ' included service left' : ' included services left')));
    }

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
    data.wigs.forEach(function (wig, index) {
      // A button, not a div: opening the panel is an action, so it has to be
      // reachable by keyboard and announce itself to a screen reader.
      var card = el('button', 'tc-closet-card tc-closet-wig');
      card.type = 'button';
      card.setAttribute('data-wig-index', String(index));
      card.setAttribute('aria-label', 'Open details for ' + wig.nickname);

      var photo = el('span', 'tc-closet-wig__photo');
      if (wig.photoUrl) {
        var img = document.createElement('img');
        img.src = wig.photoUrl;
        img.alt = wig.nickname;
        img.loading = 'lazy';
        photo.appendChild(img);
      } else {
        // Until photo storage is wired the unit still needs a face. An initial
        // reads as deliberate; a broken image reads as a bug.
        photo.appendChild(el('span', 'tc-closet-wig__initial',
          (wig.nickname || '?').trim().charAt(0).toUpperCase()));
      }
      card.appendChild(photo);

      card.appendChild(el('span', 'tc-closet-card__title', wig.nickname));

      var spec = specLine(wig);
      if (spec) card.appendChild(el('span', 'tc-closet-card__label', spec));

      var serviced = formatDate(wig.lastServicedAt);
      card.appendChild(el('span', 'tc-closet-card__meta',
        serviced ? 'Last serviced ' + serviced : 'Never serviced'));

      if (!wig.isTCollection) card.appendChild(el('span', 'tc-closet-chip', 'Outside unit'));

      card.addEventListener('click', function () { openPanel(index); });
      grid.appendChild(card);
    });
    host.appendChild(grid);

    if (serviceUrl) {
      var cta = el('a', 'tc-btn tc-btn--dark tc-closet-cta', 'Send a wig in');
      cta.href = serviceUrl;
      host.appendChild(cta);
    }
  }

  // -------------------------------------------------------------------------
  // Detail panel
  //
  // Follows the information order of the design: header with pagination, then
  // a main column running title -> unit -> why it is here -> photos -> history,
  // a side column of service and membership facts, and a footer that carries
  // the only decision a member can make from here.
  // -------------------------------------------------------------------------

  function buildPanel() {
    // Carries `tc-section` as well: thetcollection.css scopes both its design
    // tokens and its shared components (chips, labels, buttons) under that
    // class, and this panel is appended to <body> rather than inside the
    // section. Without it every var(--tc-*) resolves to nothing and the dialog
    // renders transparent.
    var wrap = el('div', 'tc-section tc-closet-panel');
    wrap.hidden = true;
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', 'Unit details');

    var scrim = el('button', 'tc-closet-panel__scrim');
    scrim.type = 'button';
    scrim.setAttribute('aria-label', 'Close');
    scrim.addEventListener('click', closePanel);
    wrap.appendChild(scrim);

    var dialog = el('div', 'tc-closet-panel__dialog');

    var header = el('div', 'tc-closet-panel__header');
    var count = el('span', 'tc-closet-panel__count');
    count.setAttribute('data-panel-count', '');
    header.appendChild(count);

    var nav = el('div', 'tc-closet-panel__nav');
    var prev = el('button', 'tc-closet-panel__btn', '\u2039');
    prev.type = 'button';
    prev.setAttribute('aria-label', 'Previous unit');
    prev.addEventListener('click', function () { openPanel(panelIndex - 1); });
    var next = el('button', 'tc-closet-panel__btn', '\u203a');
    next.type = 'button';
    next.setAttribute('aria-label', 'Next unit');
    next.addEventListener('click', function () { openPanel(panelIndex + 1); });
    nav.appendChild(prev);
    nav.appendChild(next);
    header.appendChild(nav);

    var close = el('button', 'tc-closet-panel__btn tc-closet-panel__btn--close', '\u2715');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close details');
    close.addEventListener('click', closePanel);
    header.appendChild(close);
    dialog.appendChild(header);

    var body = el('div', 'tc-closet-panel__body');
    var main = el('div', 'tc-closet-panel__main');
    main.setAttribute('data-panel-main', '');
    var side = el('div', 'tc-closet-panel__side');
    side.setAttribute('data-panel-side', '');
    body.appendChild(main);
    body.appendChild(side);
    dialog.appendChild(body);

    var footer = el('div', 'tc-closet-panel__footer');
    footer.setAttribute('data-panel-footer', '');
    dialog.appendChild(footer);

    wrap.appendChild(dialog);
    document.body.appendChild(wrap);

    wrap._prev = prev;
    wrap._next = next;
    wrap._close = close;
    return wrap;
  }

  function section(title) {
    var node = el('div', 'tc-closet-panel__section');
    node.appendChild(el('h3', null, title));
    return node;
  }

  function detailRow(term, value) {
    var row = el('div', 'tc-closet-panel__row');
    row.appendChild(el('dt', null, term));
    row.appendChild(el('dd', null, value));
    return row;
  }

  function closePanel() {
    if (!panel) return;
    panel.hidden = true;
    document.documentElement.style.overflow = '';
    panelIndex = -1;
    if (lastFocused && lastFocused.focus) lastFocused.focus();
    lastFocused = null;
  }

  function openPanel(index) {
    if (!closetData || !closetData.wigs || !closetData.wigs.length) return;
    if (index < 0 || index >= closetData.wigs.length) return;

    if (!panel) panel = buildPanel();
    if (panelIndex === -1) lastFocused = document.activeElement;
    panelIndex = index;

    var wig = closetData.wigs[index];
    panel.hidden = false;
    // The page behind must not scroll while a modal is open.
    document.documentElement.style.overflow = 'hidden';

    panel.querySelector('[data-panel-count]').textContent =
      'Wig ' + (index + 1) + ' of ' + closetData.wigs.length;
    panel._prev.disabled = index === 0;
    panel._next.disabled = index === closetData.wigs.length - 1;
    panel._close.focus();

    renderPanelLoading(wig);

    fetch(base + '/wig?id=' + encodeURIComponent(wig.id), {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin'
    })
      .then(function (response) { return response.json(); })
      .then(function (detail) {
        // A stale response from a unit the member has already paged past must
        // not overwrite the one they are looking at now.
        if (panelIndex !== index || panel.hidden) return;
        if (!detail || detail.ok === false || detail.found === false) {
          renderPanelError(wig);
          return;
        }
        renderPanelDetail(detail, index);
      })
      .catch(function () {
        if (panelIndex === index && !panel.hidden) renderPanelError(wig);
      });
  }

  function renderPanelLoading(wig) {
    var main = panel.querySelector('[data-panel-main]');
    var side = panel.querySelector('[data-panel-side]');
    var footer = panel.querySelector('[data-panel-footer]');
    main.textContent = '';
    side.textContent = '';
    footer.textContent = '';

    var head = el('div');
    head.appendChild(el('h2', 'tc-closet-panel__title', wig.nickname));
    var spec = specLine(wig);
    if (spec) head.appendChild(el('p', 'tc-closet-panel__sub', spec));
    main.appendChild(head);
    main.appendChild(el('div', 'tc-closet-skeleton'));
  }

  function renderPanelError(wig) {
    var main = panel.querySelector('[data-panel-main]');
    main.textContent = '';
    main.appendChild(el('h2', 'tc-closet-panel__title', wig.nickname));
    main.appendChild(el('p', 'tc-closet-panel__empty',
      'We could not load this unit just now. Your records are safe \u2014 please try again in a moment.'));
  }

  function renderPanelDetail(detail, index) {
    var main = panel.querySelector('[data-panel-main]');
    var side = panel.querySelector('[data-panel-side]');
    var footer = panel.querySelector('[data-panel-footer]');
    main.textContent = '';
    side.textContent = '';
    footer.textContent = '';

    var wig = detail.wig;
    var services = detail.services || [];
    // The open work order, if there is one — everything else is history.
    var current = null;
    for (var i = 0; i < services.length; i++) {
      if (services[i].status !== 'completed' && services[i].status !== 'cancelled') {
        current = services[i];
        break;
      }
    }

    // --- title -------------------------------------------------------------
    var head = el('div');
    var titleRow = el('div', 'tc-closet-panel__titlerow');
    titleRow.appendChild(el('h2', 'tc-closet-panel__title', wig.nickname));
    titleRow.appendChild(el('span', 'tc-closet-chip',
      current ? statusLabel(current.status) : 'At home'));
    head.appendChild(titleRow);

    var serviced = formatDay(wig.lastServicedAt);
    var sub = el('p', 'tc-closet-panel__sub');
    sub.appendChild(document.createTextNode(serviced ? 'Last serviced ' : 'Never serviced'));
    if (serviced) sub.appendChild(el('strong', null, serviced));
    sub.appendChild(document.createTextNode(
      '  \u00b7  ' + services.length + (services.length === 1 ? ' service on record' : ' services on record')));
    head.appendChild(sub);
    main.appendChild(head);

    // --- the unit itself ---------------------------------------------------
    var unitSection = section('Unit');
    var unit = el('div', 'tc-closet-panel__unit');
    var thumb = el('div', 'tc-closet-panel__thumb');
    if (wig.photoUrl) {
      var thumbImg = document.createElement('img');
      thumbImg.src = wig.photoUrl;
      thumbImg.alt = wig.nickname;
      thumb.appendChild(thumbImg);
    } else {
      thumb.textContent = (wig.nickname || '?').trim().charAt(0).toUpperCase();
    }
    unit.appendChild(thumb);

    var unitText = el('div');
    unitText.appendChild(el('div', 'tc-closet-panel__unitname', wig.nickname));
    var spec = specLine(wig);
    if (spec) unitText.appendChild(el('div', 'tc-closet-panel__unitspec', spec));
    var extra = [wig.laceType, wig.capSize, wig.brand].filter(Boolean).join('  \u00b7  ');
    if (extra) unitText.appendChild(el('div', 'tc-closet-panel__unitspec', extra));
    unit.appendChild(unitText);
    unitSection.appendChild(unit);
    main.appendChild(unitSection);

    // --- why it is with us -------------------------------------------------
    if (current && current.customerNotes) {
      var reasonSection = el('div', 'tc-closet-panel__section');
      var reason = el('div', 'tc-closet-panel__reason');
      var reasonBody = el('div');
      reasonBody.appendChild(el('em', null, 'What you told us'));
      reasonBody.appendChild(el('p', null, current.customerNotes));
      reason.appendChild(reasonBody);
      reasonSection.appendChild(reason);
      main.appendChild(reasonSection);
    }

    // --- photos ------------------------------------------------------------
    var photoSection = section('Photos');
    if (detail.photos && detail.photos.length) {
      var gallery = el('div', 'tc-closet-panel__photos');
      detail.photos.forEach(function (photo) {
        var cell = el('div', 'tc-closet-panel__photo');
        if (photo.url) {
          var pimg = document.createElement('img');
          pimg.src = photo.url;
          pimg.alt = photo.caption || photo.kind;
          pimg.loading = 'lazy';
          cell.appendChild(pimg);
        }
        cell.appendChild(el('span', null, photo.caption || photo.kind));
        gallery.appendChild(cell);
      });
      photoSection.appendChild(gallery);
    } else {
      photoSection.appendChild(el('p', 'tc-closet-panel__empty',
        'No photos shared yet. Anything the studio documents and marks visible will appear here.'));
    }
    main.appendChild(photoSection);

    // --- history -----------------------------------------------------------
    var historySection = section('History');
    if (!services.length) {
      historySection.appendChild(el('p', 'tc-closet-panel__empty',
        'This unit has not been in the spa yet.'));
    } else {
      services.forEach(function (service) {
        var entry = el('div', 'tc-closet-panel__entry');
        var entryHead = el('div', 'tc-closet-panel__entryhead');
        entryHead.appendChild(el('span', 'tc-closet-panel__entryname', service.serviceType));
        entryHead.appendChild(el('span', 'tc-closet-card__label', statusLabel(service.status)));
        if (service.coveredByAllowance) entryHead.appendChild(el('span', 'tc-closet-chip', 'Included'));
        entry.appendChild(entryHead);

        var when = formatDay(service.completedAt || service.submittedAt);
        if (when) entry.appendChild(el('div', 'tc-closet-panel__unitspec',
          (service.completedAt ? 'Completed ' : 'Submitted ') + when));

        if (service.events && service.events.length) {
          var list = el('ul', 'tc-closet-panel__events');
          service.events.forEach(function (event) {
            var label = event.toStatus ? statusLabel(event.toStatus) : event.kind.replace(/_/g, ' ');
            var at = formatDay(event.at);
            list.appendChild(el('li', null, at ? label + '  \u00b7  ' + at : label));
          });
          entry.appendChild(list);
        }
        historySection.appendChild(entry);
      });
    }
    main.appendChild(historySection);

    // --- side: this service ------------------------------------------------
    var facts = section(current ? 'This service' : 'Unit details');
    var rows = el('dl', 'tc-closet-panel__rows');
    if (current) {
      rows.appendChild(detailRow('Service', current.serviceType));
      rows.appendChild(detailRow('Status', statusLabel(current.status)));
      var submitted = formatDay(current.submittedAt);
      if (submitted) rows.appendChild(detailRow('Submitted', submitted));
      rows.appendChild(detailRow('Covered', current.coveredByAllowance ? 'By membership' : 'Paid service'));
      if (current.inspection && typeof current.inspection.additionalCostCents === 'number') {
        rows.appendChild(detailRow('Additional work',
          formatMoney(current.inspection.additionalCostCents, current.inspection.currency)));
      }
    } else {
      if (wig.brand) rows.appendChild(detailRow('Brand', wig.brand));
      if (wig.capSize) rows.appendChild(detailRow('Cap size', wig.capSize));
      if (wig.laceType) rows.appendChild(detailRow('Lace', wig.laceType));
      var bought = formatDay(wig.purchasedOn);
      if (bought) rows.appendChild(detailRow('Purchased', bought));
      rows.appendChild(detailRow('Origin', wig.isTCollection ? 'The T Collection' : 'Outside unit'));
    }
    facts.appendChild(rows);
    side.appendChild(facts);

    // --- side: membership --------------------------------------------------
    if (closetData.membership) {
      var m = closetData.membership;
      var memberSection = section('Your membership');
      var mrows = el('dl', 'tc-closet-panel__rows');
      mrows.appendChild(detailRow('Tier', m.tier));
      if (typeof m.discountPercent === 'number' && m.discountPercent > 0) {
        mrows.appendChild(detailRow('Member pricing', m.discountPercent + '% off'));
      }
      var remaining = typeof m.servicesRemaining === 'number' ? m.servicesRemaining : 0;
      if (remaining > 0) mrows.appendChild(detailRow('Included services left', String(remaining)));
      var renews = formatDate(m.renewsOn);
      if (renews) mrows.appendChild(detailRow('Renews', renews));
      memberSection.appendChild(mrows);
      side.appendChild(memberSection);
    }

    // --- side: notes from the studio ---------------------------------------
    var notesSection = section('Notes from the studio');
    var notes = services.filter(function (service) { return service.studioNotes; });
    if (notes.length) {
      notes.forEach(function (service) {
        var note = el('div', 'tc-closet-panel__note');
        note.appendChild(el('em', null, service.serviceType));
        note.appendChild(document.createTextNode(service.studioNotes));
        notesSection.appendChild(note);
      });
    } else {
      notesSection.appendChild(el('p', 'tc-closet-panel__empty',
        'No notes yet. Anything the studio writes for you about this unit shows up here.'));
    }
    side.appendChild(notesSection);

    // --- footer ------------------------------------------------------------
    renderPanelFooter(footer, current, index);
  }

  function formatMoney(cents, currency) {
    var amount = (cents || 0) / 100;
    try {
      return amount.toLocaleString(undefined, { style: 'currency', currency: currency || 'USD' });
    } catch (e) {
      return '$' + amount.toFixed(2);
    }
  }

  function renderPanelFooter(footer, current, index) {
    var pending = current
      && current.status === 'awaiting_customer_approval'
      && current.inspection
      && current.inspection.customerApproved === null;

    if (pending) {
      var ask = el('p');
      ask.textContent = current.inspection.recommendedWork
        ? current.inspection.recommendedWork
        : 'The studio has recommended additional work on this unit.';
      footer.appendChild(ask);

      var actions = el('div', 'tc-closet-panel__actions');
      var reject = el('button', 'tc-closet-panel__link', 'Not this time');
      reject.type = 'button';
      reject.addEventListener('click', function () { decide(current.id, false, index); });
      var approve = el('button', 'tc-btn tc-btn--dark', 'Approve the work');
      approve.type = 'button';
      approve.addEventListener('click', function () { decide(current.id, true, index); });
      actions.appendChild(reject);
      actions.appendChild(approve);
      footer.appendChild(actions);
      return;
    }

    var note = el('p');
    note.textContent = current
      ? 'We will let you know as soon as this moves.'
      : 'This unit is at home with you.';
    footer.appendChild(note);

    if (serviceUrl) {
      var send = el('a', 'tc-btn tc-btn--outline', 'Send this unit in');
      send.href = serviceUrl;
      footer.appendChild(send);
    }
  }

  /**
   * Records the member's answer to a recommended-work quote.
   *
   * Nothing is charged here — the endpoint writes the decision and moves the
   * work order. Buttons are disabled for the round trip so a double click
   * cannot post twice.
   */
  function decide(serviceRequestId, approved, index) {
    var footer = panel.querySelector('[data-panel-footer]');
    footer.querySelectorAll('button').forEach(function (button) { button.disabled = true; });

    fetch(base + '/service-decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ serviceRequestId: serviceRequestId, approved: approved })
    })
      .then(function (response) { return response.json(); })
      .then(function (result) {
        if (!result || result.ok === false) throw new Error('failed');
        // Re-open on the same unit so every section reflects the new status,
        // rather than patching the footer and leaving the rest stale.
        openPanel(index);
      })
      .catch(function () {
        footer.textContent = '';
        footer.appendChild(el('p', null,
          'We could not record that just now. Please try again, or contact the studio.'));
      });
  }

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' || !panel || panel.hidden) return;
    closePanel();
  });

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
      // Held for the detail panel: paging between units and showing membership
      // context should not cost another round trip.
      closetData = data;
      renderMembership(data);
      renderActive(data);
      renderWigs(data);
      show('ready');
    })
    .catch(function (error) {
      fail(error && error.message);
    });
})();
