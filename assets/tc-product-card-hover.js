/* Hover-triggered product card video.
 * - Skips on prefers-reduced-motion: reduce
 * - Skips on touch-only devices (no hover capability)
 * - Lazy-plays only when user hovers; resets on mouseleave
 * - Idempotent: safe to re-scan after Shopify section reload
 */
(function () {
  if (window.__tcCardHoverVideoInit) return;
  window.__tcCardHoverVideoInit = true;

  var reducedMotionMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  var hoverCapableMQ = window.matchMedia('(hover: hover)');

  function shouldRun() {
    return !reducedMotionMQ.matches && hoverCapableMQ.matches;
  }

  function bind(card) {
    if (card.dataset.tcVideoBound === '1') return;
    var video = card.querySelector('.tc-card-hover-video');
    if (!video) return;
    card.dataset.tcVideoBound = '1';

    card.addEventListener('mouseenter', function () {
      var p = video.play();
      if (p && typeof p.catch === 'function') p.catch(function () {});
    });

    card.addEventListener('mouseleave', function () {
      try {
        video.pause();
        video.currentTime = 0;
      } catch (e) {
        /* ignore */
      }
    });
  }

  function scan() {
    if (!shouldRun()) return;
    document
      .querySelectorAll('.product-card-wrapper')
      .forEach(bind);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scan);
  } else {
    scan();
  }

  // Re-bind when the customizer reloads a section
  document.addEventListener('shopify:section:load', scan);
})();
