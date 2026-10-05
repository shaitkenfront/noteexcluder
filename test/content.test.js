const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(process.env.NOTEEXCLUDER_CONTENT_SCRIPT || path.join(__dirname, '..', 'content.js'), 'utf8');
const desktopClass = 'm-largeNoteWrapper__card';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function card(id, author = '', options = {}) {
  const { tag = 'div', className = desktopClass, title = '記事', slug = id } = options;
  const link = author ? `<a href="/${author}/n/${slug}">${title}</a>` : title;
  return `<${tag} id="${id}" class="${className}"><h3>${link}</h3></${tag}>`;
}

async function setup(t, html, options = {}) {
  const dom = new JSDOM(`<html><head>${options.noTitle ? '' : '<title>note</title>'}</head><body><main>${html}</main></body></html>`, {
    url: options.url || 'https://note.com/search?q=test',
    runScripts: 'outside-only'
  });
  const { window } = dom;
  const observers = [];
  const errors = [];
  const NativeMutationObserver = window.MutationObserver;
  window.MutationObserver = class extends NativeMutationObserver {
    constructor(callback) {
      super(callback);
      observers.push(this);
    }
  };
  window.addEventListener('error', event => errors.push(event.error));
  t.after(() => {
    // jsdomのcloseによるDOM削除を、実際のページ更新として扱わない。
    observers.forEach(observer => observer.disconnect());
    dom.window.close();
    assert.deepEqual(errors, [], '監視処理で例外が発生しないこと');
  });
  const files = options.files || {};
  let storageListener;
  let scanCount = 0;
  if (options.debug) window.localStorage.setItem('noteexcluder_debug', '1');
  window.console.log = label => {
    if (label === '[NoteExcluder] scanCards') scanCount++;
  };
  window.matchMedia = () => ({ matches: Boolean(options.mobile) });
  window.fetch = async url => ({ ok: true, text: async () => files[url] || '' });
  window.chrome = {
    runtime: { getURL: file => file },
    storage: {
      local: { get: (keys, callback) => callback({}) },
      onChanged: { addListener: listener => { storageListener = listener; } }
    }
  };
  window.eval(source);
  // 設定ファイルの非同期読み込みと最初の走査が完了するまで待つ。
  for (let attempt = 0; attempt < 100 && !storageListener; attempt++) {
    await wait(10);
  }
  assert.ok(storageListener, '初期化が完了すること');
  return {
    window,
    document: window.document,
    list: window.document.querySelector('main'),
    get: id => window.document.getElementById(id),
    getScanCount: () => scanCount,
    changeStorage: users => storageListener({ extraExcludedUsers: { newValue: users } }, 'local')
  };
}

function visible(element) {
  assert.equal(element.style.getPropertyValue('display'), '');
  assert.equal(element.dataset.noteexcluderHidden, undefined);
}

function hidden(element, reason = 'duplicate') {
  assert.equal(element.style.getPropertyValue('display'), 'none');
  assert.equal(element.style.getPropertyPriority('display'), 'important');
  assert.equal(element.dataset.noteexcluderHidden, reason);
}

for (const layout of [
  { name: '旧デスクトップ', className: desktopClass },
  { name: '新デスクトップ', className: 'flex w-full rounded-lg bg-surface-normal' },
  { name: 'モバイル', tag: 'figure', className: 'o-horizontalTimeLineNote', mobile: true }
]) {
  test(`${layout.name}: スクロールで一括追加されたカードにも著者の重複を適用する`, async t => {
    const { list, get } = await setup(t, card('first', 'alice', layout), layout);
    list.insertAdjacentHTML('beforeend', `<section>${card('old', 'alice', layout)}${card('bob', 'bob', layout)}${card('bob-old', 'bob', layout)}</section>`);
    await wait(100);
    visible(get('first'));
    hidden(get('old'));
    visible(get('bob'));
    hidden(get('bob-old'));
  });
}

test('初期再走査の終了後に著者リンクが読み込まれても重複を適用する', async t => {
  const { list, get, getScanCount, document } = await setup(t, card('first', 'alice'), { debug: true });
  list.insertAdjacentHTML('beforeend', card('late'));
  // 従来のリトライと初期再走査の期限を超えるまで待つ。
  await wait(5200);
  const scansBefore = getScanCount();
  get('late').querySelector('h3').insertAdjacentHTML('beforeend', '<a href="/alice/n/late">後から届いたリンク</a>');
  await wait(100);
  visible(get('first'));
  hidden(get('late'));
  assert.equal(getScanCount(), scansBefore + 1, '更新をまとめて1回だけ走査すること');
  document.body.insertAdjacentHTML('beforeend', '<aside>カードと無関係な更新</aside>');
  await wait(100);
  assert.equal(getScanCount(), scansBefore + 1, '自分自身やカード外の変更で走査を繰り返さないこと');
});

test('既存リンクのhrefだけが後から設定された場合にも重複を適用する', async t => {
  const { get } = await setup(t, `${card('first', 'alice')}<div id="late" class="${desktopClass}"><h3><a>読み込み中</a></h3></div>`);
  get('late').querySelector('a').setAttribute('href', '/alice/n/late');
  await wait(100);
  hidden(get('late'));
});

test('著者情報の到着順にかかわらず一覧の先頭の記事を表示する', async t => {
  const { get } = await setup(t, card('first') + card('second', 'alice'));
  visible(get('second'));
  get('first').querySelector('h3').innerHTML = '<a href="/alice/n/first">先頭の記事</a>';
  await wait(100);
  visible(get('first'));
  hidden(get('second'));
});

test('処理済みカードが別の記事に再利用された時に著者を数え直す', async t => {
  const { list, get } = await setup(t, card('alice', 'alice') + card('reused', 'bob'));
  get('reused').querySelector('a').setAttribute('href', '/alice/n/other');
  list.insertAdjacentHTML('beforeend', card('bob-new', 'bob'));
  await wait(100);
  hidden(get('reused'));
  visible(get('bob-new'));
  get('reused').querySelector('a').setAttribute('href', '/carol/n/other');
  await wait(100);
  visible(get('reused'));
});

test('表示記事が削除されたら同じ著者の残りの記事を表示する', async t => {
  const { list, get } = await setup(t, card('first', 'alice') + card('second', 'alice'));
  hidden(get('second'));
  get('first').remove();
  await wait(100);
  visible(get('second'));
  get('second').remove();
  await wait(100);
  list.insertAdjacentHTML('beforeend', card('third', 'alice'));
  await wait(100);
  visible(get('third'));
});

test('カードが並べ替えられた場合も一覧の先頭だけを表示する', async t => {
  const { list, get } = await setup(t, card('first', 'alice') + card('second', 'alice'));
  list.prepend(get('second'));
  await wait(100);
  visible(get('second'));
  hidden(get('first'));
});

test('後からNGワードのテキストが届いた場合、残りの記事を表示する', async t => {
  const { get } = await setup(t, card('first', 'alice') + card('second', 'alice'), { files: { 'ng_words.txt': '広告' } });
  get('first').querySelector('a').firstChild.data = '広告の記事';
  await wait(100);
  hidden(get('first'), 'ng-word');
  visible(get('second'));
});

test('後から有料表示のクラスが設定された場合も除外する', async t => {
  const { get } = await setup(t, card('first', 'alice') + card('second', 'alice'));
  const price = get('first').ownerDocument.createElement('span');
  price.textContent = '¥100';
  get('first').append(price);
  await wait(100);
  price.className = 'text-text-success';
  await wait(100);
  hidden(get('first'), 'paid');
  visible(get('second'));
});

test('後から外部リンクが設定された場合も除外する', async t => {
  const { get } = await setup(t, card('first', 'alice') + card('second', 'alice'));
  get('first').querySelector('a').setAttribute('href', 'https://example.com/article');
  await wait(100);
  hidden(get('first'), 'external-link');
  visible(get('second'));
});

test('後からカード用クラスが設定された場合も検知する', async t => {
  const { get } = await setup(t, card('first', 'alice') + card('late', 'alice', { className: 'loading' }));
  get('late').className = desktopClass;
  await wait(100);
  hidden(get('late'));
});

test('プロフィールページと全表示URLの例外を維持する', async t => {
  const profile = await setup(t, card('first', 'alice'), { url: 'https://note.com/alice' });
  profile.list.insertAdjacentHTML('beforeend', card('old', 'alice'));
  await wait(100);
  visible(profile.get('first'));
  visible(profile.get('old'));

  const allowed = await setup(t, card('first', 'alice'), { files: { 'allow_urls.txt': 'https://note.com/alice/n/allowed' } });
  allowed.list.insertAdjacentHTML('beforeend', card('allowed', 'alice') + card('old', 'alice'));
  await wait(100);
  visible(allowed.get('allowed'));
  hidden(allowed.get('old'));
});

test('著者が遅れて判明した有料記事でも有料許可ユーザーを適用する', async t => {
  const { get } = await setup(t, `<div id="paid" class="${desktopClass}"><h3>記事</h3><span class="text-text-success">¥100</span></div>`, {
    files: { 'allow_paid_users.txt': 'alice' }
  });
  hidden(get('paid'), 'paid');
  get('paid').querySelector('h3').innerHTML = '<a href="/alice/n/paid">記事</a>';
  await wait(100);
  visible(get('paid'));
});

test('保存済み除外リストの更新を追加読み込みにも適用する', async t => {
  const { list, get, changeStorage } = await setup(t, card('first', 'alice'));
  changeStorage(['alice']);
  hidden(get('first'), 'user');
  list.insertAdjacentHTML('beforeend', card('old', 'alice'));
  await wait(100);
  hidden(get('old'), 'user');
  changeStorage([]);
  visible(get('first'));
  hidden(get('old'));
});

test('タイトル要素がなくても初期化とSPA遷移後の監視が継続する', async t => {
  const { window, list, get } = await setup(t, card('first', 'alice') + card('second', 'alice'), { noTitle: true });
  hidden(get('second'));
  window.history.pushState({}, '', '/alice');
  list.insertAdjacentHTML('beforeend', card('third', 'alice'));
  await wait(100);
  visible(get('first'));
  visible(get('second'));
  visible(get('third'));
  window.history.pushState({}, '', '/search?q=again');
  list.insertAdjacentHTML('beforeend', card('fourth', 'alice'));
  await wait(100);
  visible(get('first'));
  hidden(get('second'));
  hidden(get('third'));
  hidden(get('fourth'));
});
