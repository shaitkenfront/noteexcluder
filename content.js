(function () {
  'use strict';

  const DESKTOP_CARD_SELECTOR = [
    '[class*="m-largeNoteWrapper__card"]',
    'div.flex.w-full.rounded-lg.bg-surface-normal'
  ].join(', ');
  const MOBILE_CARD_SELECTOR = [
    'figure[class*="o-horizontalTimeLineNote"]'
  ].join(', ');
  const ARTICLE_LINK_SELECTOR = 'a[href*="/n/"]';
  const STORAGE_EXCLUDE_KEY = 'extraExcludedUsers';
  const RESERVED_TOP_LEVEL_PATHS = new Set([
    'about',
    'account',
    'creators',
    'events',
    'help',
    'interests',
    'magazines',
    'messages',
    'n',
    'notifications',
    'recommendations',
    'search',
    'settings',
    'timeline'
  ]);
  const AUTHOR_RETRY_DELAYS_MS = [150, 500, 1500];
  const INITIAL_RESCAN_DELAYS_MS = [300, 1000, 2500, 5000];
  const CARD_RETRY_ATTR = 'noteexcluderRetryCount';
  const DEBUG =
    location.search.includes('noteexcluder_debug=1') ||
    window.localStorage?.getItem('noteexcluder_debug') === '1';

  let fileExcludeUsers = new Set();
  let excludeUsers = new Set();
  let allowPaidUsers = new Set();
  let allowUrls = new Set();
  let visibleAuthorCounts = new Map();
  let lastUrl = location.href;

  async function init() {
    try {
      fileExcludeUsers = await loadExcludeUsers();
      excludeUsers = mergeSets(fileExcludeUsers, await loadStoredExcludeUsers());
      allowPaidUsers = await loadAllowPaidUsers();
      allowUrls = await loadAllowUrls();
      debugLog('init', {
        excludeUsers: Array.from(excludeUsers),
        allowPaidUsers: Array.from(allowPaidUsers),
        allowUrls: Array.from(allowUrls)
      });
    } catch (e) {
      console.warn('[NoteExcluder] 除外設定ファイルの読み込みに失敗:', e);
      fileExcludeUsers = new Set();
      excludeUsers = new Set();
      allowPaidUsers = new Set();
      allowUrls = new Set();
    }

    resetOnUrlChange();
    observeStorageChanges();
    scanCards();
    scheduleInitialRescans();
    observeMutations();
  }

  function resetOnUrlChange() {
    // SPAの遷移を検知して状態をリセット
    const observer = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        console.log('[NoteExcluder] URLが変更されたため、表示済み著者リストをリセットしました');
        rescanAllCards();
      }
    });
    observer.observe(document.querySelector('head > title'), { subtree: true, characterData: true, childList: true });

    // popstateイベントも一応ハンドル
    window.addEventListener('popstate', () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        rescanAllCards();
      }
    });
  }

  function observeStorageChanges() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes[STORAGE_EXCLUDE_KEY]) return;

      excludeUsers = mergeSets(
        fileExcludeUsers,
        normalizeStoredUserList(changes[STORAGE_EXCLUDE_KEY].newValue)
      );
      rescanAllCards();
    });
  }

  async function loadExcludeUsers() {
    return loadUserList('excludes.txt', 'excludes.txt');
  }

  async function loadAllowPaidUsers() {
    return loadUserList('allow_paid_users.txt', 'allow_paid_users.txt');
  }

  async function loadAllowUrls() {
    const url = chrome.runtime.getURL('allow_urls.txt');
    const urls = new Set();
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const text = await res.text();
      debugLog('loadAllowUrls:raw', { url, text });
      text.split(/\r?\n/).forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const normalized = normalizeNoteUrl(trimmed);
        if (normalized) urls.add(normalized);
      });
      debugLog('loadAllowUrls:parsed', { urls: Array.from(urls) });
    } catch (e) {
      console.warn('[NoteExcluder] allow_urls.txt の読み込みに失敗しました:', e);
    }
    return urls;
  }

  async function loadUserList(fileName, label) {
    const url = chrome.runtime.getURL(fileName);
    const users = new Set();
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const text = await res.text();
      debugLog('loadUserList:raw', { label, url, text });
      text.split(/\r?\n/).forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const normalized = normalizeUsername(trimmed);
        if (normalized) users.add(normalized);
      });
      debugLog('loadUserList:parsed', { label, users: Array.from(users) });
    } catch (e) {
      console.warn(`[NoteExcluder] ${label} の読み込みに失敗しました:`, e);
    }
    return users;
  }

  async function loadStoredExcludeUsers() {
    try {
      const stored = await getLocalStorageValue(STORAGE_EXCLUDE_KEY);
      return normalizeStoredUserList(stored);
    } catch (e) {
      console.warn('[NoteExcluder] 保存済み除外ユーザーの読み込みに失敗しました:', e);
      return new Set();
    }
  }

  function getLocalStorageValue(key) {
    return new Promise(resolve => {
      chrome.storage.local.get([key], result => {
        resolve(result?.[key]);
      });
    });
  }

  function normalizeStoredUserList(value) {
    if (!Array.isArray(value)) return new Set();
    const users = new Set();
    value.forEach(entry => {
      const normalized = normalizeUsername(entry);
      if (normalized) users.add(normalized);
    });
    return users;
  }

  function mergeSets(...sets) {
    const merged = new Set();
    sets.forEach(set => {
      set?.forEach(value => {
        merged.add(value);
      });
    });
    return merged;
  }

  function scanCards() {
    const cards = collectCards(document);
    debugLog('scanCards', { count: cards.length, mode: getLayoutMode() });
    cards.forEach(processCard);
  }

  function scheduleInitialRescans() {
    INITIAL_RESCAN_DELAYS_MS.forEach(delay => {
      window.setTimeout(() => {
        debugLog('scheduledRescan', { delay });
        scanCards();
      }, delay);
    });
  }

  function rescanAllCards() {
    visibleAuthorCounts.clear();
    collectCards(document).forEach(resetCardState);
    scanCards();
  }

  function observeMutations() {
    const observer = new MutationObserver(mutations => {
      const cardsToProcess = new Set();
      const selector = getActiveCardSelector();

      for (const mutation of mutations) {
        if (mutation.type !== 'childList') continue;
        mutation.addedNodes.forEach(node => {
          if (!(node instanceof HTMLElement)) return;
          if (node.matches?.(selector)) {
            cardsToProcess.add(node);
          }
          node.querySelectorAll?.(selector).forEach(card => {
            cardsToProcess.add(card);
          });
        });
      }

      if (cardsToProcess.size > 0) {
        debugLog('mutation', { count: cardsToProcess.size });
      }
      cardsToProcess.forEach(processCard);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function processCard(card) {
    if (!(card instanceof HTMLElement)) return;
    if (card.dataset.noteexcluderProcessed === '1') return;
    card.dataset.noteexcluderProcessed = '1';

    const author = extractAuthorUsername(card);
    debugLog('processCard', {
      author,
      links: Array.from(card.querySelectorAll('a[href]')).map(link => link.href)
    });

    if (hasAllowedUrl(card)) {
      if (author) {
        markAuthorVisible(card, author);
      }
      debugLog('allowedUrl', { author });
      return;
    }

    if (!author) {
      if (isPaidCard(card)) {
        hideCard(card, 'paid');
        return;
      }

      scheduleCardRetry(card);
      return;
    }

    if (excludeUsers.has(author)) {
      debugLog('hide:user', { author });
      hideCard(card, 'user');
      return;
    }

    if (isPaidCard(card) && !isPaidUser(author)) {
      debugLog('hide:paid', { author });
      hideCard(card, 'paid');
      return;
    }

    // プロフィールページの場合は、そのユーザーに対する「重複表示」の非表示化をスキップする
    const profileUser = getProfilePageUser();
    if (profileUser && author === profileUser) {
      markAuthorVisible(card, author);
      return;
    }

    // 同一作者の2記事目以降を非表示にする
    if (getVisibleAuthorCount(author) > 0) {
      debugLog('hide:duplicate', { author });
      hideCard(card, 'duplicate');
      return;
    }

    // 初回表示の作者を記録
    markAuthorVisible(card, author);
  }

  function getProfilePageUser() {
    // 自身のプロフィールページ URL例: https://note.com/namidanoz
    // 他人のプロフィールページ URL例: https://note.com/example_user
    // pathnameが /username もしくは /username/rss 等かを判定
    const segments = location.pathname.split('/').filter(Boolean);
    if (segments.length === 1) {
      const first = normalizePathSegment(segments[0]);
      if (isUserPathSegment(first)) {
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
    let bestCandidate = '';
    let bestScore = -1;
    const links = card.querySelectorAll('a[href]');
    for (const link of links) {
      const candidate = extractUsernameCandidate(link.getAttribute('href'));
      if (!candidate) continue;
      if (candidate.score > bestScore) {
        bestCandidate = candidate.username;
        bestScore = candidate.score;
      }
    }
    return bestCandidate;
  }

  function collectCards(root) {
    const cards = new Set();
    if (!(root instanceof Element || root instanceof Document)) {
      return cards;
    }

    const selector = getActiveCardSelector();

    if (root instanceof Element) {
      if (root.matches?.(selector)) {
        cards.add(root);
      }
      const ownCard = findCardContainer(root);
      if (ownCard) {
        cards.add(ownCard);
      }
    }

    root.querySelectorAll?.(selector).forEach(card => {
      cards.add(card);
    });

    if (getLayoutMode() === 'mobile') {
      root.querySelectorAll?.(ARTICLE_LINK_SELECTOR).forEach(link => {
        const card = findCardContainer(link);
        if (card) {
          cards.add(card);
        }
      });
    }

    return cards;
  }

  function findCardContainer(start) {
    if (!(start instanceof Element)) return null;

    const selector = getActiveCardSelector();
    const direct = start.closest(selector);
    if (direct) return direct;

    if (getLayoutMode() === 'mobile') {
      const anchor = start.matches?.(ARTICLE_LINK_SELECTOR)
        ? start
        : start.closest(ARTICLE_LINK_SELECTOR);
      const mobileCard = anchor?.closest?.(MOBILE_CARD_SELECTOR);
      if (mobileCard instanceof HTMLElement) {
        return mobileCard;
      }
    }

    return null;
  }

  function getActiveCardSelector() {
    return getLayoutMode() === 'mobile' ? MOBILE_CARD_SELECTOR : DESKTOP_CARD_SELECTOR;
  }

  function getLayoutMode() {
    return window.matchMedia('(max-width: 768px)').matches ? 'mobile' : 'desktop';
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

  function resetCardState(card) {
    if (!(card instanceof HTMLElement)) return;
    unmarkAuthorVisible(card);
    if (card.dataset.noteexcluderHidden) {
      card.style.removeProperty('display');
      delete card.dataset.noteexcluderHidden;
    }
    delete card.dataset.noteexcluderProcessed;
    delete card.dataset[CARD_RETRY_ATTR];
    delete card.dataset.noteexcluderAuthor;
    delete card.dataset.noteexcluderAuthorCounted;
  }

  function scheduleCardRetry(card) {
    if (!(card instanceof HTMLElement)) return;

    const retryCount = Number(card.dataset[CARD_RETRY_ATTR] || '0');
    if (retryCount >= AUTHOR_RETRY_DELAYS_MS.length) {
      console.debug('[NoteExcluder] 著者名を特定できないカードをスキップしました', card);
      return;
    }

    card.dataset[CARD_RETRY_ATTR] = String(retryCount + 1);
    delete card.dataset.noteexcluderProcessed;

    window.setTimeout(() => {
      if (!document.contains(card)) return;
      processCard(card);
    }, AUTHOR_RETRY_DELAYS_MS[retryCount]);
  }

  function isPaidUser(username) {
    return Boolean(username) && allowPaidUsers.has(username);
  }

  function getVisibleAuthorCount(author) {
    return visibleAuthorCounts.get(author) || 0;
  }

  function markAuthorVisible(card, author) {
    if (!(card instanceof HTMLElement) || !author) return;
    if (card.dataset.noteexcluderAuthorCounted === '1' && card.dataset.noteexcluderAuthor === author) {
      return;
    }

    unmarkAuthorVisible(card);
    card.dataset.noteexcluderAuthor = author;
    card.dataset.noteexcluderAuthorCounted = '1';
    visibleAuthorCounts.set(author, getVisibleAuthorCount(author) + 1);
  }

  function unmarkAuthorVisible(card) {
    if (!(card instanceof HTMLElement)) return;
    if (card.dataset.noteexcluderAuthorCounted !== '1') return;

    const author = card.dataset.noteexcluderAuthor;
    if (author) {
      const next = getVisibleAuthorCount(author) - 1;
      if (next > 0) {
        visibleAuthorCounts.set(author, next);
      } else {
        visibleAuthorCounts.delete(author);
      }
    }
    delete card.dataset.noteexcluderAuthor;
    delete card.dataset.noteexcluderAuthorCounted;
  }

  function normalizeUsername(input) {
    const s = String(input).trim();
    if (!s) return '';
    if (s.startsWith('@')) return normalizePathSegment(s.slice(1));

    if (looksLikeUrlOrPath(s)) {
      const fromUrl = extractUsernameFromNoteUrl(s);
      if (fromUrl) return fromUrl;
    }
    return normalizePathSegment(s);
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

  function extractUsernameCandidate(input) {
    const url = parseNoteUrl(input);
    if (!url) return null;

    const username = extractUsernameFromNoteUrl(url);
    if (!username) return null;

    const segments = url.pathname.split('/').filter(Boolean).map(normalizePathSegment);
    if (segments.length >= 2 && segments[1] === 'n') {
      return { username, score: 3 };
    }
    if (segments.length === 1) {
      return { username, score: 2 };
    }
    return { username, score: 1 };
  }

  function extractUsernameFromNoteUrl(input) {
    const url = input instanceof URL ? input : parseNoteUrl(input);
    if (!url) return '';

    const segments = url.pathname.split('/').filter(Boolean).map(normalizePathSegment);
    if (segments.length === 0) return '';

    const first = segments[0];
    return isUserPathSegment(first) ? first : '';
  }

  function isUserPathSegment(segment) {
    return /^[a-z0-9_-]+$/.test(segment) && !RESERVED_TOP_LEVEL_PATHS.has(segment);
  }

  function normalizePathSegment(input) {
    return String(input || '').trim().replace(/^@/, '').toLowerCase();
  }

  function looksLikeUrlOrPath(input) {
    const s = String(input || '').trim();
    return /^(https?:)?\/\//i.test(s) || s.startsWith('/') || s.includes('/');
  }

  function compactText(text) {
    return (text || '').replace(/\s+/g, '');
  }

  function debugLog(label, payload) {
    if (!DEBUG) return;
    console.log(`[NoteExcluder] ${label}`, payload);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
