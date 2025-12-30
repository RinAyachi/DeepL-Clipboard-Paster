// content-script.js
// Replace your extension's content script with this file.

var hiragana = /[\u3040-\u309f]/;
var katakana = /[\u30a0-\u30ff]/;
var kanji = /[\u4e00-\u9faf]/;
var maxLineLength = 200;

(() => {
  'use strict';

  // --- helper: find source element (textarea / input / contenteditable)
  function findSourceEl() {
    // 1) obvious selector (textarea input)
    let el = document.querySelector('[data-testid="translator-source-input"]');
    if (el) {
      // sometimes wrapper returned; try inside
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable) return el;
      const inner = el.querySelector('textarea, input, [contenteditable="true"]');
      if (inner) return inner;
    }

    // 2) aria-labelledby (fallback)
    el = document.querySelector('[aria-labelledby="translation-source-heading"] [contenteditable="true"]');
    if (el) return el;

    // 3) dummy id fallback
    el = document.querySelector('#source-dummydiv') || document.querySelector('#source-dummydiv')?.parentElement;
    if (el && (el.tagName === 'TEXTAREA' || el.isContentEditable)) return el;

    // 4) fallback general: first textarea on page (often source is left-most)
    const areas = document.querySelectorAll('textarea');
    if (areas.length) return areas[0];

    return null;
  }

  // --- helper: set value using native setter (works with React inputs)
  function setNativeValue(el, value) {
    if (!el) return false;
    try {
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value') ||
                     Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value') ||
                     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        if (desc && desc.set) {
          desc.set.call(el, value);
        } else {
          el.value = value;
        }
        // dispatch events React/listeners expect
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        // extra: composition events just in case
        el.dispatchEvent(new Event('compositionend', { bubbles: true }));
        return true;
      } else if (el.isContentEditable) {
        el.focus();
        el.innerText = value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('compositionend', { bubbles: true }));
        return true;
      }
    } catch (e) {
      console.warn('[AutoPaste] setNativeValue error', e);
    }
    return false;
  }

  // --- fallback: inject code into page context to run setter there (stronger)
  function injectIntoPageAndSet(text) {
    const cleaned = text.replace(/…+|‥+/g, "...").replace(/―+/g, "-");
    const fn = function(t) {
      // run in page context
      (function findAndSet(textToSet) {
        function find() {
          let el = document.querySelector('[data-testid="translator-source-input"]');
          if (el) {
            if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable) return el;
            const inner = el.querySelector('textarea, input, [contenteditable="true"]');
            if (inner) return inner;
          }
          el = document.querySelector('[aria-labelledby="translation-source-heading"] [contenteditable="true"]');
          if (el) return el;
          const areas = document.querySelectorAll('textarea');
          if (areas.length) return areas[0];
          return null;
        }

        function setUsingNative(el, v) {
          try {
            if (!el) return false;
            if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
              const proto = Object.getPrototypeOf(el);
              const desc = Object.getOwnPropertyDescriptor(proto, 'value') ||
                           Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value') ||
                           Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
              if (desc && desc.set) {
                desc.set.call(el, v);
              } else {
                el.value = v;
              }
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new Event('compositionend', { bubbles: true }));
              return true;
            } else if (el.isContentEditable) {
              el.focus();
              el.innerText = v;
              el.dispatchEvent(new InputEvent('input', { bubbles: true, data: v }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new Event('compositionend', { bubbles: true }));
              return true;
            }
          } catch (e) {
            /* ignore */
          }
          return false;
        }

        // try a few times to cover lazy-loaded UI
        let tries = 0;
        const maxTries = 10;
        const tryLoop = () => {
          const el = find();
          if (el && setUsingNative(el, textToSet)) {
            console.log('[AutoPaste][page] success set text');
            return;
          }
          tries++;
          if (tries < maxTries) {
            setTimeout(tryLoop, 300);
          } else {
            console.warn('[AutoPaste][page] failed to set text after tries');
            // as last resort, change location hash (legacy fallback)
            try { window.location.hash = 'ja/en/' + encodeURIComponent(textToSet); } catch(e){/*ignore*/ }
          }
        };
        tryLoop();
      })(t);
    };

    const wrapper = '(' + fn.toString() + ')(' + JSON.stringify(cleaned) + ');';
    const s = document.createElement('script');
    s.textContent = wrapper;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  }

  // --- try set with retries from content script; if fail, inject into page
  function setSourceText(text) {
    const cleaned = text.replace(/…+|‥+/g, "...").replace(/―+/g, "-");
    return new Promise((resolve) => {
      let attempts = 0;
      const maxAttempts = 8;
      const trySet = () => {
        const el = findSourceEl();
        if (el && setNativeValue(el, cleaned)) {
          // verify quickly
          const current = (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') ? (el.value || '').trim() : (el.innerText || el.textContent || '').trim();
          if (current === cleaned.trim()) {
            console.log('[AutoPaste] set from content-script (ok)');
            resolve(true);
            return;
          }
        }
        attempts++;
        if (attempts >= maxAttempts) {
          // fallback to injecting into page (stronger)
          console.warn('[AutoPaste] content-script set failed, injecting into page context...');
          injectIntoPageAndSet(text);
          // resolve true to indicate we attempted inject (can't guarantee)
          resolve(true);
          return;
        }
        setTimeout(trySet, 300);
      };
      trySet();
    });
  }

  // --- message listener from extension
  function processMessage(msg) {
    switch (msg.action) {
      case 'insert':
        if (!msg || !msg.text) return;
        if ((hiragana.test(msg.text) || katakana.test(msg.text) || kanji.test(msg.text)) &&
            msg.text.length <= maxLineLength) {
          setSourceText(msg.text).then(() => {
            // done (either set or injected)
          });
        } else {
          // if not Japanese or too long, fallback to hash change for compatibility
          try { window.location.hash = 'ja/en/' + encodeURIComponent(msg.text); } catch(e){/*ignore*/ }
        }
        break;
      case 'uninject':
        chrome.runtime.onMessage.removeListener(processMessage);
        break;
    }
  }

  chrome.runtime.onMessage.addListener(processMessage);
})();
