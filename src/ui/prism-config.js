// Point the Prism autoloader at the vendored language components. Load right
// after prism-autoloader.min.js (chat.html, llm-response.html).
try { if (window.Prism && Prism.plugins && Prism.plugins.autoloader) { Prism.plugins.autoloader.languages_path = './node_modules/prismjs/components/'; } } catch (_) {}
