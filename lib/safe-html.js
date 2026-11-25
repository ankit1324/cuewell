// sanitizeHtml(html): run model-derived HTML through DOMPurify before it is
// assigned to innerHTML. Load after node_modules/dompurify/dist/purify.min.js.
// Without DOMPurify the input is escaped and shown as plain text (fail closed).
(function () {
    'use strict';

    var CONFIG = {
        USE_PROFILES: { html: true, svg: true, mathMl: true },
        FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
        // lib/mathrender.js and Prism only add class attributes, and both run
        // after sanitizing, so inline styles can go.
        FORBID_ATTR: ['style'],
        ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|#|data:image\/(?:png|jpe?g|gif|webp);base64,)/i,
        // Prefix id/name values so injected markup cannot shadow page globals
        // that are only feature-detected (e.g. `typeof marked`).
        SANITIZE_NAMED_PROPS: true,
        // No data-* attributes: library gadgets read them, e.g. Prism's
        // file-highlight plugin fetches the file named by pre[data-src].
        ALLOW_DATA_ATTR: false
    };

    function escapeHtml(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    var purify = window.DOMPurify;
    var ready = !!(purify && purify.isSupported && typeof purify.sanitize === 'function');

    if (ready) {
        // Links never navigate the app window: they go through the main
        // process window-open handler, which only opens http(s) externally.
        purify.addHook('afterSanitizeAttributes', function (node) {
            if (String(node.nodeName).toLowerCase() === 'a' &&
                (node.hasAttribute('href') || node.hasAttribute('xlink:href'))) {
                node.setAttribute('target', '_blank');
                node.setAttribute('rel', 'noopener noreferrer');
            }
        });
    } else {
        console.error('[safe-html] DOMPurify unavailable; rendering model output as plain text');
    }

    window.sanitizeHtml = function sanitizeHtml(html) {
        if (!ready) return escapeHtml(html);
        return purify.sanitize(String(html == null ? '' : html), CONFIG);
    };
})();
