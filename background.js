const MENU_ID = 'noteexcluder-hide-author';
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

chrome.runtime.onInstalled.addListener(() => {
  createContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  createContextMenu();
});

const supportsDynamicContextMenuVisibility =
  Boolean(chrome.contextMenus.onShown?.addListener) &&
  typeof chrome.contextMenus.refresh === 'function';

if (supportsDynamicContextMenuVisibility) {
  chrome.contextMenus.onShown.addListener(info => {
    chrome.contextMenus.update(
      MENU_ID,
      { visible: Boolean(extractProfileUsernameFromNoteUrl(info.linkUrl)) },
      () => chrome.contextMenus.refresh()
    );
  });
}

chrome.contextMenus.onClicked.addListener(info => {
  if (info.menuItemId !== MENU_ID) return;

  const username = extractProfileUsernameFromNoteUrl(info.linkUrl);
  if (!username) return;

  chrome.storage.local.get([STORAGE_EXCLUDE_KEY], result => {
    const current = Array.isArray(result?.[STORAGE_EXCLUDE_KEY]) ? result[STORAGE_EXCLUDE_KEY] : [];
    const next = Array.from(
      new Set(
        current
          .map(normalizePathSegment)
          .concat(username)
          .filter(Boolean)
      )
    ).sort();

    chrome.storage.local.set({ [STORAGE_EXCLUDE_KEY]: next });
  });
});

function createContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'この作者を非表示',
      contexts: ['link'],
      documentUrlPatterns: ['https://note.com/*'],
      targetUrlPatterns: ['https://note.com/*'],
      // onShown/refresh 非対応のブラウザでは常に表示し、
      // クリック時にリンクがプロフィール URL かどうかを判定する。
      visible: !supportsDynamicContextMenuVisibility
    });
  });
}

function extractProfileUsernameFromNoteUrl(input) {
  const url = parseNoteUrl(input);
  if (!url) return '';

  const segments = url.pathname.split('/').filter(Boolean).map(normalizePathSegment);
  if (segments.length !== 1) return '';

  const first = segments[0];
  return isUserPathSegment(first) ? first : '';
}

function parseNoteUrl(input) {
  const s = String(input || '').trim();
  if (!s) return null;

  try {
    const url = new URL(s);
    if (url.hostname.endsWith('note.com')) {
      return url;
    }
  } catch (_) {
    // ignore
  }
  return null;
}

function isUserPathSegment(segment) {
  return /^[a-z0-9_-]+$/.test(segment) && !RESERVED_TOP_LEVEL_PATHS.has(segment);
}

function normalizePathSegment(input) {
  return String(input || '').trim().replace(/^@/, '').toLowerCase();
}
