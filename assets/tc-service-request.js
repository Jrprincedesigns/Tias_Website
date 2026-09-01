/**
 * Send a wig in.
 *
 * Three requests, in order: register the unit if it's new, upload each photo
 * straight to storage with a one-path signed ticket, then submit the request
 * with the paths that came back. The browser never holds a storage key, and the
 * server re-checks that every path belongs to this member before writing it.
 */
(function () {
  'use strict';

  var form = document.querySelector('[data-tc-request]');
  if (!form) return;

  var base = form.getAttribute('data-proxy-base') || '/apps/spa';
  var maxPhotos = Number(form.getAttribute('data-max-photos') || 6);
  var closetUrl = form.getAttribute('data-closet-url') || '';

  var wigsHost = form.querySelector('[data-request-wigs]');
  var photosHost = form.querySelector('[data-request-photos]');
  var fileInput = form.querySelector('[data-request-file]');
  var statusEl = form.querySelector('[data-request-status]');
  var submitBtn = form.querySelector('[data-request-submit]');
  var coverageEl = form.querySelector('[data-request-coverage]');

  /** Files chosen but not yet uploaded: { file, path|null, error|null }. */
  var pending = [];
  var membership = null;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function say(message, tone) {
    statusEl.textContent = message || '';
    statusEl.className = 'tc-request__status' + (tone ? ' is-' + tone : '');
  }

  function post(path, body) {
    return fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body)
    }).then(function (response) {
      return response.text().then(function (text) {
        var data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          throw new Error('We could not reach the studio. Please try again shortly.');
        }
        if (data.ok === false) {
          throw new Error(
            (data.details && data.details.join('. ')) ||
            'The studio service is temporarily unavailable.'
          );
        }
        return data;
      });
    });
  }

  /* --- the member's units ------------------------------------------------- */

  function renderWigs(closet) {
    wigsHost.textContent = '';
    membership = closet.membership;

    if (membership) {
      coverageEl.hidden = false;
      coverageEl.textContent = membership.servicesRemaining > 0
        ? membership.servicesRemaining + ' included service' +
          (membership.servicesRemaining === 1 ? '' : 's') + ' remaining on your membership.'
        : 'You have used your included services for this membership year — member rates still apply.';
    }

    (closet.wigs || []).forEach(function (wig, index) {
      var label = el('label', 'tc-request__choice');
      var input = el('input');
      input.type = 'radio';
      input.name = 'wigId';
      input.value = wig.id;
      input.required = true;
      if (index === 0) input.checked = true;

      var spec = [wig.lengthInches ? wig.lengthInches + '"' : null, wig.texture, wig.color]
        .filter(Boolean).join(' · ');

      var text = el('span');
      text.appendChild(el('strong', null, wig.nickname));
      if (spec) text.appendChild(el('em', null, spec));

      label.appendChild(input);
      label.appendChild(text);
      wigsHost.appendChild(label);
    });

    // Registering a new unit is part of this form, not a separate journey —
    // a member sending their first wig would otherwise hit a dead end.
    var addLabel = el('label', 'tc-request__choice');
    var addInput = el('input');
    addInput.type = 'radio';
    addInput.name = 'wigId';
    addInput.value = '__new__';
    addInput.required = true;
    if ((closet.wigs || []).length === 0) addInput.checked = true;

    var addText = el('span');
    addText.appendChild(el('strong', null,
      (closet.wigs || []).length === 0 ? 'Add your first unit' : 'A different unit'));
    addText.appendChild(el('em', null, "We'll keep its history from here on."));

    addLabel.appendChild(addInput);
    addLabel.appendChild(addText);
    wigsHost.appendChild(addLabel);

    var newFields = el('div', 'tc-request__new');
    newFields.hidden = addInput.checked === false;
    newFields.innerHTML =
      '<div class="tc-field"><label for="new-nickname">What do you call it?</label>' +
      '<input type="text" id="new-nickname" name="newNickname" placeholder="Chocolate Body Wave"></div>' +
      '<div class="tc-request__row">' +
      '<div class="tc-field"><label for="new-length">Length (inches)</label>' +
      '<input type="number" id="new-length" name="newLength" min="1" max="60"></div>' +
      '<div class="tc-field"><label for="new-texture">Texture</label>' +
      '<input type="text" id="new-texture" name="newTexture" placeholder="Body wave"></div>' +
      '</div>' +
      '<label class="tc-request__inline"><input type="checkbox" name="newIsTC">' +
      ' This is a T Collection unit</label>';
    wigsHost.appendChild(newFields);

    form.addEventListener('change', function (event) {
      if (event.target && event.target.name === 'wigId') {
        newFields.hidden = event.target.value !== '__new__';
      }
    });
  }

  fetch(base + '/closet', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.ok === false || data.signedIn === false) {
        throw new Error('We could not load your units.');
      }
      renderWigs(data);
    })
    .catch(function (error) {
      wigsHost.textContent = '';
      wigsHost.appendChild(el('p', 'tc-request__hint', error.message));
    });

  /* --- photographs -------------------------------------------------------- */

  function drawPhotos() {
    photosHost.textContent = '';
    pending.forEach(function (item, index) {
      var chip = el('div', 'tc-request__photo' + (item.error ? ' is-error' : ''));
      chip.appendChild(el('span', null, item.file.name));
      chip.appendChild(el('em', null,
        item.error ? item.error : item.path ? 'ready' : 'uploading…'));

      var remove = el('button', 'tc-request__remove', 'Remove');
      remove.type = 'button';
      remove.addEventListener('click', function () {
        pending.splice(index, 1);
        drawPhotos();
      });
      chip.appendChild(remove);
      photosHost.appendChild(chip);
    });
  }

  function uploadOne(item) {
    return post('/upload-url', { contentType: item.file.type, size: item.file.size })
      .then(function (ticket) {
        // Straight to storage — the file never passes through the app.
        return fetch(ticket.signedUrl, {
          method: 'PUT',
          headers: { 'Content-Type': ticket.contentType, 'x-upsert': 'false' },
          body: item.file
        }).then(function (response) {
          if (!response.ok) throw new Error('Upload failed');
          item.path = ticket.path;
          item.error = null;
        });
      })
      .catch(function (error) {
        item.error = error.message || 'Upload failed';
      })
      .then(drawPhotos);
  }

  if (fileInput) {
    fileInput.addEventListener('change', function () {
      var chosen = Array.prototype.slice.call(fileInput.files || []);
      fileInput.value = '';

      chosen.forEach(function (file) {
        if (pending.length >= maxPhotos) {
          say('You can send up to ' + maxPhotos + ' photos.', 'error');
          return;
        }
        var item = { file: file, path: null, error: null };
        pending.push(item);
        drawPhotos();
        uploadOne(item);
      });
    });
  }

  /* --- submitting ---------------------------------------------------------- */

  form.addEventListener('submit', function (event) {
    event.preventDefault();

    var data = new FormData(form);
    var wigChoice = data.get('wigId');
    var serviceType = data.get('serviceType');

    if (!wigChoice) return say('Choose which unit you are sending.', 'error');
    if (!serviceType) return say('Choose what the unit needs.', 'error');
    if (pending.some(function (item) { return !item.path && !item.error; })) {
      return say('Your photos are still uploading — one moment.', 'error');
    }

    // Questions are theme-editor blocks, so their names are not known ahead of
    // time. Everything prefixed intake: travels through as the member answered it.
    var answers = {};
    data.forEach(function (value, key) {
      if (key.indexOf('intake:') === 0 && String(value).trim() !== '') {
        answers[key.slice('intake:'.length)] = String(value).trim();
      }
    });

    var photoPaths = pending
      .filter(function (item) { return item.path; })
      .map(function (item) { return item.path; });

    submitBtn.disabled = true;
    say('Sending…');

    Promise.resolve()
      .then(function () {
        if (wigChoice !== '__new__') return wigChoice;
        return post('/wigs', {
          nickname: data.get('newNickname'),
          lengthInches: data.get('newLength'),
          texture: data.get('newTexture'),
          isTCollection: data.get('newIsTC') === 'on'
        }).then(function (result) { return result.wig.id; });
      })
      .then(function (wigId) {
        return post('/service-request', {
          wigId: wigId,
          serviceType: serviceType,
          notes: data.get('notes'),
          answers: answers,
          photoPaths: photoPaths
        });
      })
      .then(function (result) {
        form.hidden = true;
        var done = el('div', 'tc-request__done');
        done.appendChild(el('h2', null, "We've got it."));
        done.appendChild(el('p', null,
          result.coveredByAllowance
            ? "This one is included with your membership. We'll email you shipping details shortly."
            : "We'll email you shipping details and a quote shortly."));
        if (closetUrl) {
          var link = el('a', 'tc-btn tc-btn--dark', 'View your closet');
          link.href = closetUrl;
          done.appendChild(link);
        }
        form.parentNode.appendChild(done);
      })
      .catch(function (error) {
        submitBtn.disabled = false;
        say(error.message || 'Something went wrong. Please try again.', 'error');
      });
  });
})();
