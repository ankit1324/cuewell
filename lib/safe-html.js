// sanitizeHtml(html): run model-derived HTML through DOMPurify before it is
// assigned to innerHTML. Load after node_modules/dompurify/dist/purify.min.js.
// Without DOMPurify the input is escaped and shown as plain text (fail closed).
(function () {
    'use strict';

    var CONFIG = {
        // HTML only: no SVG or MathML (lib/mathrender.js emits plain
        // span/sup/sub).
        USE_PROFILES: { html: true },
        FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
        // lib/mathrender.js and Prism only add class attributes, and both run
        // after sanitizing, so inline styles can go. srcset is a URL list the
        // http(s) check below would only test at its start.
        FORBID_ATTR: ['style', 'srcset'],
        // DOMPurify checks this against every attribute that is not on its
        // URI-safe list, so plain values like align="left" or start="3"
        // (marked tables and lists) must still pass. This is DOMPurify's
        // default with every scheme except http(s) removed; URL attributes
        // are then held to http(s) only by the hook below.
        // eslint-disable-next-line no-useless-escape -- DOMPurify's regexp, kept verbatim
        ALLOWED_URI_REGEXP: /^(?:https?:|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
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

    // Attributes that load or navigate to a URL. Only absolute http(s)
    // values are kept: no data:, no relative paths into the app folder.
    var URL_ATTRS = {
        href: true, src: true, 'xlink:href': true, action: true,
        formaction: true, poster: true, background: true, cite: true
    };
    var HTTP_URL = /^https?:\/\//i;

    if (ready) {
        purify.addHook('uponSanitizeAttribute', function (node, data) {
            if (!URL_ATTRS[data.attrName]) return;
            // Same whitespace stripping DOMPurify uses for its own URI check.
            // eslint-disable-next-line no-control-regex -- strips control characters on purpose
            var value = String(data.attrValue || '').replace(/[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g, '');
            if (!HTTP_URL.test(value)) data.keepAttr = false;
        });
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
