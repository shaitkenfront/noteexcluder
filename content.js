(function () {
  'use strict';

  const CARD_SELECTOR = '[class*="m-largeNoteWrapper__card"], div.flex.w-full.rounded-lg.bg-surface-normal';

  let excludeUsers = new Set();
  let allowUrls = new Set();
  let seenAuthors = new Set();
  let lastUrl = location.href;

  async function init() {
    try {
      excludeUsers = await loadExcludeUsers();
      allowUrls = await loadAllowUrls();
    } catch (e) {
      console.warn('[NoteExcluder] 除外設定ファイルの読み込みに失敗:', e);
      excludeUsers = new Set();
      allowUrls = new Set();
    }

    resetOnUrlChange();
    scanCards();
    observeMutations();
  }

  function resetOnUrlChange() {
    // SPAの遷移を検知して状態をリセット
    const observer = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        seenAuthors.clear();
        console.log('[NoteExcluder] URLが変更されたため、表示済み著者リストをリセットしました');
        scanCards();
      }
    });
    observer.observe(document.querySelector('head > title'), { subtree: true, characterData: true, childList: true });

    // popstateイベントも一応ハンドル
    window.addEventListener('popstate', () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        seenAuthors.clear();
        scanCards();
      }
    });
  }

  async function loadExcludeUsers() {
    const url = chrome.runtime.getURL('excludes.txt');
    const users = new Set();
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const text = await res.text();
      text.split(/\r?\n/).forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const normalized = normalizeUsername(trimmed);
        if (normalized) users.add(normalized);
      });
    } catch (e) {
      console.warn('[NoteExcluder] excludes.txt の読み込みに失敗しました:', e);
    }
    return users;
  }

  async function loadAllowUrls() {
    const url = chrome.runtime.getURL('allow_urls.txt');
    const urls = new Set();
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const text = await res.text();
      text.split(/\r?\n/).forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const normalized = normalizeNoteUrl(trimmed);
        if (normalized) urls.add(normalized);
      });
    } catch (e) {
      console.warn('[NoteExcluder] allow_urls.txt の読み込みに失敗しました:', e);
    }
    return urls;
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
    if (typeof card.matches === 'function' && !card.matches(CARD_SELECTOR)) return;
    if (card.dataset.noteexcluderProcessed === '1') return;
    card.dataset.noteexcluderProcessed = '1';

    const author = extractAuthorUsername(card);

    if (hasAllowedUrl(card)) {
      if (author) {
        seenAuthors.add(author);
      }
      return;
    }

    if (isPaidCard(card)) {
      hideCard(card, 'paid');
      return;
    }

    if (author) {
      if (excludeUsers.has(author)) {
        hideCard(card, 'user');
        return;
      }

      // プロフィールページの場合は、そのユーザーに対する「重複表示」の非表示化をスキップする
      const profileUser = getProfilePageUser();
      if (profileUser && author === profileUser) {
        return;
      }

      // 同一作者の2記事目以降を非表示にする
      if (seenAuthors.has(author)) {
        hideCard(card, 'duplicate');
        return;
      }

      // 初回表示の作者を記録
      seenAuthors.add(author);
    }
  }

  function getProfilePageUser() {
    // 自身のプロフィールページ URL例: https://note.com/namidanoz
    // 他人のプロフィールページ URL例: https://note.com/example_user
    // pathnameが /username もしくは /username/rss 等かを判定
    const segments = location.pathname.split('/').filter(Boolean);
    if (segments.length === 1) {
      const first = segments[0];
      // note.comのトップレベル予約語でなければユーザーIDとみなす
      const reserved = ['recommendations', 'timeline', 'interests', 'search', 'settings', 'notifications', 'messages', 'magazines', 'n'];
      if (!reserved.includes(first)) {
        return first;
      }
    }
    return null;
  }

  function isPaidCard(card) {
    // 新デザイン（興味・関心ページ等）での明示的な有料判定
    // 有料記事には <span class="text-text-success text-sm">¥1,980</span> のような要素が含まれる
    if (card.querySelector('.text-text-success')) {
      return true;
    }

    // 旧デザイン用の判定
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
      const url = parseNoteUrl(link.getAttribute('href'));
      if (!url) continue;
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

  function hasAllowedUrl(card) {
    const links = card.querySelectorAll('a[href]');
    for (const link of links) {
      const normalized = normalizeNoteUrl(link.getAttribute('href'));
      if (normalized && allowUrls.has(normalized)) {
        return true;
      }
    }
    return false;
  }

  function hideCard(card, reason) {
    card.style.setProperty('display', 'none', 'important');
    card.dataset.noteexcluderHidden = reason;
  }

  function normalizeUsername(input) {
    const s = String(input).trim();
    if (!s) return '';
    if (s.startsWith('@')) return s.slice(1);

    const url = parseNoteUrl(s);
    if (!url) return s;

    const segments = url.pathname.split('/').filter(Boolean);
    return segments[0] || '';
  }

  function normalizeNoteUrl(input) {
    const url = input instanceof URL ? input : parseNoteUrl(input);
    if (!url) return '';

    const normalized = new URL(url.toString());
    normalized.hash = '';
    normalized.search = '';
    normalized.pathname = normalized.pathname.replace(/\/+$/, '');
    return normalized.toString();
  }

  function parseNoteUrl(input) {
    const s = String(input || '').trim();
    if (!s) return null;
    try {
      const url = new URL(s, location.href);
      if (url.hostname.endsWith('note.com')) {
        return url;
      }
    } catch (_) {
      // ignore
    }
    return null;
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
