/*
 * Cuewell website: scroll reveal, code copy, and the live demo stage.
 * No dependencies, no network. Everything still reads fine without this file.
 */
(function () {
  'use strict';

  var doc = document;
  // Set here, not inline, so a failed script load never hides content.
  doc.documentElement.classList.add('js');
  var reduceMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  function $(sel, root) { return (root || doc).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); }

  /* ---------- Scroll reveal ---------- */

  function initReveal() {
    var els = $$('.reveal');
    if (!('IntersectionObserver' in window) || reduceMQ.matches) {
      els.forEach(function (el) { el.classList.add('is-in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });
    els.forEach(function (el) { io.observe(el); });
  }

  /* ---------- Copy buttons on code blocks ---------- */

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = doc.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.opacity = '0';
      doc.body.appendChild(ta);
      ta.select();
      try { (doc.execCommand('copy') ? resolve : reject)(); } catch (err) { reject(err); }
      ta.remove();
    });
  }

  function initCopy() {
    doc.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('.code-copy');
      if (!btn) return;
      var code = btn.closest('.code').querySelector('pre');
      var label = btn.querySelector('span');
      var use = btn.querySelector('use');
      var live = doc.getElementById('copy-status');
      function reset() {
        clearTimeout(btn._t);
        btn._t = setTimeout(function () {
          btn.classList.remove('is-done');
          label.textContent = 'Copy';
          if (use) use.setAttribute('href', '#i-copy');
        }, 1600);
      }
      copyText(code.textContent).then(function () {
        btn.classList.add('is-done');
        label.textContent = 'Copied';
        if (use) use.setAttribute('href', '#i-check');
        if (live) live.textContent = 'Code copied to clipboard';
        reset();
      }, function () {
        // Leave the code selected so the user can copy it by hand.
        var range = doc.createRange();
        range.selectNodeContents(code);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        label.textContent = 'Press ⌘C';
        if (live) live.textContent = 'Code selected. Press Command C or Control C to copy.';
        reset();
      });
    });
  }

  /* ---------- Live demo ---------- */

  function initDemo() {
    var stage = $('#demo-stage');
    if (!stage || !('content' in doc.createElement('template'))) return;

    var scenarios = $$('template[id^="sc-"]').map(function (t) {
      return { tpl: t, q: t.dataset.q, mode: t.dataset.mode, lang: t.dataset.lang };
    });
    if (!scenarios.length) return;

    var el = {
      mic: $('#demo-mic'),
      micText: $('#demo-mic .mic-text'),
      mode: $('#demo-mode'),
      modeText: $('#demo-mode .mode-text'),
      lang: $('#demo-lang'),
      heard: $('#demo-heard'),
      heardLabel: $('#demo-heard .heard-label'),
      question: $('#demo-question'),
      status: $('#demo-status'),
      statusText: $('#demo-status .st-text'),
      progress: $('.panel-progress', stage),
      answer: $('#demo-answer'),
      counter: $('#demo-counter'),
      play: $('#demo-play'),
      playLabel: $('#demo-play-label'),
      tabs: $$('.demo-tab')
    };
    var tabBars = el.tabs.map(function (t) { return t.querySelector('.tab-bar i'); });

    /* Pause-aware clock. Time only advances while nothing pauses the demo,
       so hover, focus, scrolling away and the pause button all freeze it. */
    var clock = 0;
    var last = 0;
    var raf = 0;
    var waiters = [];
    var pauses = {};
    var run = 0;
    var current = 0;
    var scStart = 0;
    var scDur = 1;
    var animating = false;
    var lastP = -1;
    var CANCEL = {};

    function isPaused() { for (var k in pauses) if (pauses[k]) return true; return false; }

    function frame(t) {
      raf = 0;
      if (last) {
        var dt = Math.min(t - last, 64);
        if (!isPaused()) clock += dt;
      }
      last = t;
      if (waiters.length) {
        var due = [];
        waiters = waiters.filter(function (w) {
          if (w.at <= clock) { due.push(w); return false; }
          return true;
        });
        due.forEach(function (w) { w.resolve(); });
      }
      drawProgress();
      // Stop the loop entirely while paused; setPause() restarts it.
      if (animating && !isPaused()) raf = requestAnimationFrame(frame);
      else last = 0;
    }
    function ensureLoop() {
      if (!raf && animating && !isPaused()) raf = requestAnimationFrame(frame);
    }

    function sleep(ms, r) {
      return new Promise(function (resolve) {
        waiters.push({ at: clock + ms, resolve: resolve });
        ensureLoop();
      }).then(function () { if (r !== run) throw CANCEL; });
    }

    function drawProgress() {
      var p = animating ? Math.max(0, Math.min(1, (clock - scStart) / scDur)) : 0;
      if (Math.abs(p - lastP) < 0.002) return;
      lastP = p;
      tabBars.forEach(function (bar, i) {
        bar.style.transform = 'scaleX(' + (i === current ? p : 0) + ')';
      });
    }

    function setPause(key, on) {
      pauses[key] = on;
      var paused = isPaused() && animating;
      el.counter.textContent = counterText() + (paused && !pauses.offscreen ? ' · Paused' : '');
      stage.classList.toggle('is-paused', isPaused());
      ensureLoop();
    }

    /* ----- Stage state helpers ----- */

    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function counterText() { return 'Scenario ' + pad(current + 1) + ' / ' + pad(scenarios.length); }

    function selectTab(i) {
      current = i;
      el.tabs.forEach(function (tab, k) {
        var on = k === i;
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
        tab.tabIndex = on ? 0 : -1;
      });
      stage.setAttribute('aria-labelledby', el.tabs[i].id);
      el.counter.textContent = counterText();
      lastP = -1;
      drawProgress();
    }

    function setMic(live) {
      el.mic.classList.toggle('is-live', live);
      el.micText.textContent = live ? 'Listening' : 'Listen';
    }

    function setHeard(state, text) {
      el.heard.classList.toggle('is-live', state === 'live');
      el.heard.classList.toggle('is-typing', state === 'live');
      el.heard.classList.toggle('is-idle', state === 'idle');
      el.heardLabel.textContent = state === 'live' ? 'Listening' : state === 'idle' ? 'Ready' : 'Heard';
      if (text != null) el.question.textContent = text;
    }

    function setMode(name, how) {
      var m = el.mode;
      m.classList.remove('is-flash', 'is-auto', 'is-set');
      if (!name) {
        el.modeText.textContent = 'Auto';
        if (how === 'detecting') m.classList.add('is-auto');
        return;
      }
      el.modeText.textContent = name;
      m.classList.add('is-set');
      if (how === 'flash') {
        void m.offsetWidth; // restart the flash animation
        m.classList.add('is-flash');
      }
    }

    function setStatus(state, text) {
      el.status.setAttribute('data-state', state);
      el.statusText.textContent = text;
      el.progress.classList.toggle('is-on', state === 'thinking');
    }

    function idleAnswer() {
      el.answer.innerHTML = '';
      var p = doc.createElement('p');
      p.className = 'panel-idle';
      p.textContent = 'Answers appear here as they stream.';
      el.answer.appendChild(p);
      el.answer.scrollTop = 0;
    }

    /* Clone a scenario's answer. Drop whitespace-only text between block
       elements so hidden blocks don't leave stray gaps. */
    function cloneAnswer(sc) {
      var root = doc.createElement('div');
      root.appendChild(sc.tpl.content.cloneNode(true));
      var walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      var drop = [];
      var n;
      while ((n = walker.nextNode())) {
        if (/^\s*$/.test(n.data) && /^(DIV|UL|OL)$/.test(n.parentNode.nodeName)) drop.push(n);
      }
      drop.forEach(function (t) { t.remove(); });
      return root;
    }

    /* Split the answer into word tokens, all hidden, with a per-token delay. */
    function planAnswer(sc) {
      var root = cloneAnswer(sc);
      Array.prototype.forEach.call(root.children, function (child) {
        if (child.hasAttribute('data-instant')) return;
        child.classList.add('blk-off');
        $$('li', child).forEach(function (li) { li.classList.add('blk-off'); });
      });

      var texts = [];
      var walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          var p = node.parentNode;
          if (p.closest('[data-instant], .code-bar')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      var node;
      while ((node = walker.nextNode())) texts.push(node);

      var tokens = [];
      texts.forEach(function (t) {
        var chunks = t.data.match(/\s*\S+|\s+/g) || [];
        var inCode = !!t.parentNode.closest('pre');
        var frag = doc.createDocumentFragment();
        chunks.forEach(function (chunk) {
          var span = doc.createElement('span');
          span.className = 'tk-off';
          span.textContent = chunk;
          frag.appendChild(span);
          tokens.push({ el: span, ws: !/\S/.test(chunk), code: inCode, text: chunk });
        });
        t.parentNode.replaceChild(frag, t);
      });

      // Hidden ancestors to show with each token, and its top-level block.
      tokens.forEach(function (tok) {
        var hide = [];
        var top = null;
        for (var a = tok.el.parentNode; a && a !== root; a = a.parentNode) {
          if (a.classList.contains('blk-off')) hide.push(a);
          if (a.parentNode === root) top = a;
        }
        tok.hide = hide;
        tok.top = top;
      });

      var total = 0;
      tokens.forEach(function (tok, i) {
        var d;
        if (tok.ws) d = 0;
        else if (tok.code) d = 24;
        else {
          d = 34;
          var end = tok.text.trim().slice(-1);
          if ('.!?'.indexOf(end) !== -1) d += 110;
          else if (',;:'.indexOf(end) !== -1) d += 45;
        }
        var next = tokens[i + 1];
        if (!tok.ws && next && next.top !== tok.top) d += 170;
        tok.delay = d;
        total += d;
      });

      return { root: root, tokens: tokens, total: total };
    }

    var T = { lead: 450, micOn: 420, afterQ: 480, detect: 800, think: 850, hold: 4200 };
    function charDelay(ch) { return ch === ' ' ? 26 : 40; }

    var readerScrolled = false;
    ['wheel', 'touchmove'].forEach(function (type) {
      el.answer.addEventListener(type, function () { readerScrolled = true; }, { passive: true });
    });
    el.answer.addEventListener('keydown', function () { readerScrolled = true; });

    function keepVisible(span) {
      if (readerScrolled) return;
      var body = el.answer;
      var bottom = span.offsetTop + span.offsetHeight + 26;
      if (bottom > body.scrollTop + body.clientHeight) {
        body.scrollTo({ top: bottom - body.clientHeight, behavior: 'smooth' });
      }
    }

    function resetFor(sc) {
      setMic(false);
      setHeard('idle', 'Ask by voice, screenshot or chat.');
      setMode(null);
      el.lang.textContent = sc.lang;
      setStatus('idle', 'Ready');
      idleAnswer();
    }

    async function playScenario(i, r) {
      var sc = scenarios[i];
      var plan = planAnswer(sc);
      var qTime = 0;
      for (var c = 0; c < sc.q.length; c++) qTime += charDelay(sc.q[c]);

      scStart = clock;
      scDur = T.lead + T.micOn + qTime + T.afterQ + T.detect + T.think + plan.total + T.hold;
      readerScrolled = false;
      selectTab(i);
      resetFor(sc);

      await sleep(T.lead, r);
      setMic(true);
      setHeard('live', '');
      setStatus('listening', 'Listening');
      await sleep(T.micOn, r);

      for (var k = 1; k <= sc.q.length; k++) {
        el.question.textContent = sc.q.slice(0, k);
        await sleep(charDelay(sc.q[k - 1]), r);
      }
      await sleep(T.afterQ, r);

      setMic(false);
      setHeard('heard');
      setStatus('detecting', 'Detecting');
      setMode(null, 'detecting');
      await sleep(T.detect, r);

      setMode(sc.mode, 'flash');
      setStatus('thinking', 'Thinking');
      await sleep(T.think, r);

      el.answer.innerHTML = '';
      el.answer.scrollTop = 0;
      while (plan.root.firstChild) el.answer.appendChild(plan.root.firstChild);
      setStatus('streaming', 'Streaming');

      for (var t = 0; t < plan.tokens.length; t++) {
        var tok = plan.tokens[t];
        for (var h = 0; h < tok.hide.length; h++) tok.hide[h].classList.remove('blk-off');
        tok.el.className = '';
        if (tok.delay) {
          keepVisible(tok.el);
          await sleep(tok.delay, r);
        }
      }

      setStatus('done', 'Done');
      await sleep(T.hold, r);
    }

    async function runFrom(i) {
      var r = ++run;
      waiters = [];
      animating = true;
      try {
        for (;;) {
          await playScenario(i, r);
          i = (i + 1) % scenarios.length;
        }
      } catch (err) {
        if (err !== CANCEL) throw err;
      }
    }

    /* Static final state: reduced motion, or a jump while paused. */
    function renderFinal(i) {
      run++;
      waiters = [];
      animating = false;
      var sc = scenarios[i];
      selectTab(i);
      setMic(false);
      setHeard('heard', sc.q);
      setMode(sc.mode);
      el.lang.textContent = sc.lang;
      setStatus('done', 'Done');
      var root = cloneAnswer(sc);
      el.answer.innerHTML = '';
      while (root.firstChild) el.answer.appendChild(root.firstChild);
      el.answer.scrollTop = 0;
      lastP = -1;
      drawProgress();
    }

    function go(i) {
      if (reduceMQ.matches || pauses.user) renderFinal(i);
      else runFrom(i);
    }

    /* ----- Controls ----- */

    el.tabs.forEach(function (tab, i) {
      tab.addEventListener('click', function () { go(i); });
    });
    $('#demo-tabs').addEventListener('keydown', function (e) {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      var i = el.tabs.indexOf(doc.activeElement);
      if (i < 0) return;
      var n = el.tabs.length;
      var to = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = (i + 1) % n;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = (i - 1 + n) % n;
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = n - 1;
      if (to === null) return;
      e.preventDefault();
      el.tabs[to].focus();
      go(to);
    });

    function syncPlayButton() {
      var paused = !!pauses.user;
      el.play.setAttribute('data-paused', paused ? 'true' : 'false');
      el.playLabel.textContent = paused ? 'Play demo' : 'Pause demo';
      el.play.title = paused ? 'Play demo' : 'Pause demo';
    }
    el.play.addEventListener('click', function () {
      var resume = !!pauses.user;
      setPause('user', !resume);
      syncPlayButton();
      if (resume && !animating) runFrom(current);
    });

    stage.addEventListener('pointerenter', function (e) { if (e.pointerType === 'mouse') setPause('hover', true); });
    stage.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse') setPause('hover', false); });
    stage.addEventListener('focusin', function (e) {
      var keyboard = true;
      try { keyboard = e.target.matches(':focus-visible'); } catch (err) { /* old browsers */ }
      if (keyboard) setPause('focus', true);
    });
    stage.addEventListener('focusout', function (e) {
      if (!stage.contains(e.relatedTarget)) setPause('focus', false);
    });

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) { setPause('offscreen', !entry.isIntersecting); });
      }, { threshold: 0.15 }).observe(stage);
    }

    function applyMotionPref() {
      if (reduceMQ.matches) {
        el.play.hidden = true;
        renderFinal(current);
      } else {
        el.play.hidden = false;
        syncPlayButton();
        if (!pauses.user) runFrom(current);
      }
    }
    if (reduceMQ.addEventListener) reduceMQ.addEventListener('change', applyMotionPref);
    else if (reduceMQ.addListener) reduceMQ.addListener(applyMotionPref);

    applyMotionPref();
  }

  /* ---------- Animated app icon ---------- */

  /* Plays only while on screen and when motion is allowed. Otherwise the
     video is paused and hidden, and the poster image underneath shows. */
  function initAppIcons() {
    var icons = $$('.app-icon').map(function (box) {
      return { box: box, video: $('video', box), visible: false };
    }).filter(function (icon) { return icon.video; });
    if (!icons.length) return;

    function sync(icon) {
      var v = icon.video;
      var play = !reduceMQ.matches && icon.visible && !icon.failed;
      icon.box.classList.toggle('is-static', reduceMQ.matches || !!icon.failed);
      if (!play) {
        if (!v.paused) v.pause();
        return;
      }
      if (!v.paused) return;
      var p = v.play();
      // Autoplay can be refused (for example in iOS Low Power Mode): keep the poster.
      if (p && p.catch) p.catch(function () { icon.failed = true; sync(icon); });
    }

    icons.forEach(function (icon) {
      var v = icon.video;
      v.removeAttribute('autoplay');
      if (reduceMQ.matches) v.pause();
      v.addEventListener('error', function () { icon.failed = true; sync(icon); });
      // A failed webm source just falls back to mp4; only the last one counts.
      var sources = $$('source', v);
      if (sources.length) {
        sources[sources.length - 1].addEventListener('error', function () { icon.failed = true; sync(icon); });
      }
    });

    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          icons.forEach(function (icon) {
            if (icon.box === entry.target) { icon.visible = entry.isIntersecting; sync(icon); }
          });
        });
      });
      icons.forEach(function (icon) { io.observe(icon.box); });
    } else {
      icons.forEach(function (icon) { icon.visible = true; sync(icon); });
    }

    function onMotionChange() { icons.forEach(sync); }
    if (reduceMQ.addEventListener) reduceMQ.addEventListener('change', onMotionChange);
    else if (reduceMQ.addListener) reduceMQ.addListener(onMotionChange);
  }

  /* ---------- Downloads ---------- */

  /* GitHub releases of Cuewell; assets download from <url>/download/<file>
     once a release is published. While this is a "#..." placeholder, the page
     shows "Coming soon" and every download link stays on this page.
     A /releases/tag/vX.Y.Z URL also works. File names live in index.html
     (data-file on each .dl-file link). */
  var RELEASES_URL = 'https://github.com/ankit1324/cuewell/releases/latest';
  var VERSION = '1.0.2';

  function releaseBase() {
    var url = String(RELEASES_URL || '').trim().replace(/\/+$/, '');
    if (!/^https:\/\/[^\s"'<>]+$/i.test(url)) return null;
    return url;
  }

  // GitHub serves assets at .../releases/latest/download/<file> and
  // .../releases/download/<tag>/<file>.
  function fileUrl(base, file) {
    var name = encodeURIComponent(file);
    var tag = base.match(/^(.*\/releases)\/tag\/([^/?#]+)$/);
    if (tag) return tag[1] + '/download/' + tag[2] + '/' + name;
    if (/\/releases$/.test(base)) base += '/latest';
    return base + '/download/' + name;
  }

  var OS_NAMES = { mac: 'macOS', win: 'Windows', linux: 'Linux' };

  function detectOS() {
    var nav = window.navigator || {};
    var uad = nav.userAgentData;
    var ua = nav.userAgent || '';
    var platform = (uad && uad.platform) || nav.platform || '';
    // iPadOS reports itself as a Mac; touch support gives it away.
    var ipad = /Macintosh/.test(ua) && nav.maxTouchPoints > 1;
    if ((uad && uad.mobile) || ipad || /Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return 'mobile';
    if (/CrOS/.test(ua) || /Chrome OS/i.test(platform)) return 'other';
    if (/mac/i.test(platform) || /Macintosh|Mac OS X/.test(ua)) return 'mac';
    if (/win/i.test(platform) || /Windows/.test(ua)) return 'win';
    if (/linux|x11|bsd/i.test(platform) || /Linux|X11/.test(ua)) return 'linux';
    return 'other';
  }

  function initDownloads() {
    var hero = $('#hero-download');
    var base = releaseBase();
    var live = !!base;
    var os = detectOS();

    // Release state: real links, or "Coming soon" with no dead links.
    $$('[data-dl-soon]').forEach(function (n) { n.hidden = live; });
    $$('[data-dl-live]').forEach(function (n) { n.hidden = !live; });
    $$('[data-file]').forEach(function (a) {
      if (live) {
        a.href = fileUrl(base, a.getAttribute('data-file'));
        a.classList.remove('is-soon');
      } else {
        // No href: not focusable and not a dead link. The card says "Coming soon".
        a.removeAttribute('href');
        a.classList.add('is-soon');
      }
    });
    if (live) $$('[data-dl-releases]').forEach(function (a) { a.href = base; });

    if (!hero) return;
    var btn = $('[data-dl-primary]', hero);
    var label = $('[data-dl-label]', hero);
    var note = $('[data-dl-note]', hero);
    var alt = $('[data-dl-alt]', hero);
    var altLabel = $('[data-dl-alt-label]', hero);
    if (!btn || !label) return;

    function setPrimary(id, detail) {
      var link = $('[data-dl-id="' + id + '"]');
      btn.href = live && link ? link.href : '#dl-' + os;
      if (note && live) note.textContent = 'Version ' + VERSION + ' · ' + detail;
    }

    if (OS_NAMES[os]) {
      label.textContent = 'Download for ' + OS_NAMES[os];
      if (altLabel) altLabel.textContent = 'Also for';
      if (alt) $$('[data-os="' + os + '"]', alt).forEach(function (a) { a.remove(); });
    } else {
      // Phones, tablets, Chromebooks: Cuewell is a desktop app.
      label.textContent = 'See desktop downloads';
      btn.href = '#download';
      if (note && live) note.textContent = 'Desktop app for macOS, Windows and Linux.';
      return;
    }

    if (os === 'win') setPrimary('win-setup', 'Installer, no admin needed');
    else if (os === 'linux') setPrimary('linux-appimage', 'AppImage, x64');
    else {
      setPrimary('mac-arm64', 'Apple silicon');
      if (alt) {
        var intel = doc.createElement('a');
        intel.href = '#dl-mac';
        intel.textContent = 'Intel Mac';
        alt.insertBefore(intel, $('a', alt));
      }
      // Chromium can report the CPU. Safari and Firefox cannot, so Apple
      // silicon stays the default there, as it fits most current Macs.
      var uad = navigator.userAgentData;
      if (uad && uad.getHighEntropyValues) {
        uad.getHighEntropyValues(['architecture']).then(function (v) {
          if (v && v.architecture === 'x86') {
            setPrimary('mac-x64', 'Intel');
            if (intel) intel.textContent = 'Apple silicon Mac';
          }
        }, function () { /* keep the Apple silicon default */ });
      }
    }
  }

  function init() {
    initDownloads();
    initReveal();
    initCopy();
    initAppIcons();
    initDemo();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})();
