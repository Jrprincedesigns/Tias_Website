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

  // Hover containers we want to bind to. Add new ones here as needed.
  // Each video walks up to its closest matching ancestor — that ancestor
  // is the hover trigger for that video instance.
  var HOVER_CONTAINER_SELECTOR = '.product-card-wrapper, .product__media-item';

  function bindContainer(container, video) {
    if (container.dataset.tcVideoBound === '1') return;
    container.dataset.tcVideoBound = '1';

    container.addEventListener('mouseenter', function () {
      var p = video.play();
      if (p && typeof p.catch === 'function') p.catch(function () {});
    });

    container.addEventListener('mouseleave', function () {
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
    document.querySelectorAll('.tc-card-hover-video').forEach(function (video) {
      var container = video.closest(HOVER_CONTAINER_SELECTOR);
      if (!container) return;
      bindContainer(container, video);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scan);
  } else {
    scan();
  }

  // Re-bind when the customizer reloads a section
  document.addEventListener('shopify:section:load', scan);
})();
