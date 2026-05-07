/* TC mobile-nav drawer.
 * - Hamburger button toggles drawer.
 * - Drawer closes on: backdrop click, close-X, ESC key, link click.
 * - Body scroll locks when drawer is open.
 * - Idempotent: safe to re-bind after Shopify section reloads.
 */
(function () {
  if (window.__tcNavDrawerInit) return;
  window.__tcNavDrawerInit = true;

  function bind(btn) {
    if (btn.dataset.tcDrawerBound === '1') return;
    var drawerId = btn.getAttribute('aria-controls');
    if (!drawerId) return;
    var drawer = document.getElementById(drawerId);
    if (!drawer) return;
    btn.dataset.tcDrawerBound = '1';

    function isOpen() {
      return drawer.getAttribute('aria-hidden') === 'false';
    }
    function open() {
      drawer.setAttribute('aria-hidden', 'false');
      btn.setAttribute('aria-expanded', 'true');
      document.body.classList.add('tc-drawer-open');
    }
    function close() {
      drawer.setAttribute('aria-hidden', 'true');
      btn.setAttribute('aria-expanded', 'false');
      document.body.classList.remove('tc-drawer-open');
    }

    btn.addEventListener('click', function () {
      if (isOpen()) close(); else open();
    });

    drawer.querySelectorAll('[data-tc-drawer-close]').forEach(function (el) {
      el.addEventListener('click', close);
    });

    // Clicking any link inside the drawer should close it (lets the
    // route-change navigation feel snappy rather than leaving the
    // drawer open behind the new page).
    drawer.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', close);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen()) close();
    });
  }

  function scan() {
    document.querySelectorAll('.tc-nav__hamburger').forEach(bind);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scan);
  } else {
    scan();
  }
  document.addEventListener('shopify:section:load', scan);
})();
