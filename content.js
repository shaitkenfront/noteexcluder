(function () {
  'use strict';

  const CARD_SELECTOR = '[class*="m-largeNoteWrapper__card"]';

  let excludeUsers = new Set();

  async function init() {
    try {
      excludeUsers = await loadExcludeUsers();
    } catch (e) {
      console.warn('[NoteExcluder] excludes.txt の読み込みに失敗:', e);
      excludeUsers = new Set();
    }

    scanCards();
    observeMutations();
  }

  async function loadExcludeUsers() {
    const url = chrome.runtime.getURL('excludes.txt');
    const set = new Set();
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const text = await res.text();
      text.split(/\r?\n/).forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const normalized = normalizeUsername(trimmed);
        if (normalized) set.add(normalized);
      });
    } catch (e) {
      console.warn('[NoteExcluder] 除外ユーザーの読み込みに失敗しました:', e);
    }
    return set;
  }

  function scanCards() {
    document.querySelectorAll(CARD_SELECTOR).forEach(processCard);
  }

  function observeMutations() {
    const observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.type !== 'childList') continue;
        mutation.addedNodes.forEach(node => {
          if (!(node instanceof HTMLElement)) return;
          if (node.matches(CARD_SELECTOR)) {
            processCard(node);
          }
          node.querySelectorAll?.(CARD_SELECTOR).forEach(processCard);
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function processCard(card) {
    if (!(card instanceof HTMLElement)) return;
    if (!card.className || !card.className.includes('m-largeNoteWrapper__card')) return;
    if (card.dataset.noteexcluderProcessed === '1') return;
    card.dataset.noteexcluderProcessed = '1';

    if (isPaidCard(card)) {
      hideCard(card, 'paid');
      return;
    }

    const author = extractAuthorUsername(card);
    if (author && excludeUsers.has(author)) {
      hideCard(card, 'user');
    }
  }

  function isPaidCard(card) {
    const hints = card.querySelectorAll('[class*="paid" i], [class*="price" i], [class*="plan" i], [class*="member" i], [data-price], [data-paid], svg[aria-label], [aria-label*="有料"]');
    for (const hint of hints) {
      const text = compactText(hint.textContent);
      if (!text) continue;
      if (hasPaidKeyword(text)) return true;
      if (hasPrice(text)) return true;
    }

    const cardText = compactText(card.textContent);
    if (!cardText) return false;
    if (hasPaidKeyword(cardText)) return true;
    if (cardText.includes('月額') && hasPrice(cardText)) return true;
    return false;
  }

  function hasPaidKeyword(text) {
    const keywords = ['有料', '有料記事', '会員限定', '定期購読', '販売中'];
    return keywords.some(k => text.includes(k));
  }

  function hasPrice(text) {
    return /([¥￥]\s?\d[\d,]*|\d[\d,]*円)/.test(text);
  }

  function extractAuthorUsername(card) {
    const links = card.querySelectorAll('a[href]');
    for (const link of links) {
      const href = link.getAttribute('href');
      if (!href) continue;
      let url;
      try {
        url = new URL(href, location.href);
      } catch (_) {
        continue;
      }
      if (!url.hostname.endsWith('note.com')) continue;
      const segments = url.pathname.split('/').filter(Boolean);
      if (segments.length === 0) continue;
      const first = segments[0];
      if (first === 'n') continue;
      if (/^[A-Za-z0-9_\-]+$/.test(first)) {
        return first;
      }
    }
    return '';
  }

  function hideCard(card, reason) {
    card.style.setProperty('display', 'none', 'important');
    card.dataset.noteexcluderHidden = reason;
  }

  function normalizeUsername(input) {
    const s = String(input).trim();
    if (!s) return '';
    if (s.startsWith('@')) return s.slice(1);
    try {
      const url = new URL(s);
      if (url.hostname.endsWith('note.com')) {
        const segments = url.pathname.split('/').filter(Boolean);
        return segments[0] || '';
      }
    } catch (_) {
      // ignore
    }
    return s;
  }

  function compactText(text) {
    return (text || '').replace(/\s+/g, '');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
