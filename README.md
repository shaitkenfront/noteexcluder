noteexcluder

概要
- note.com 上の記事カードを対象とし、以下を非表示にする Chrome 拡張です。
  - 有料設定のある記事
  - タイトル先頭に指定の鍵SVGアイコンがある記事
  - 除外設定ファイルに含まれるユーザーの記事
  - NGワードを含む記事
  - リンク先に `note.com` 以外のドメインを含む記事
  - 同一著者の2記事目以降
  - ただし有料表示許可ファイルに含まれるユーザーの有料記事は表示する
  - ただし全表示設定ファイルに含まれる記事URLのカードは非表示にしない

使い方
- Chrome で拡張機能を開き、デベロッパーモードを有効化
- 「パッケージ化されていない拡張機能を読み込む」から本フォルダを選択
- `excludes.txt` に除外したいユーザー名を1行ずつ記載
  - 例: `foobar` / `@foobar` / `https://note.com/foobar`
- `allow_paid_users.txt` に有料記事も表示したいユーザー名を1行ずつ記載
  - 例: `foobar` / `@foobar` / `https://note.com/foobar`
- `allow_urls.txt` に全表示したい記事URLを1行ずつ記載
  - 例: `https://note.com/foobar/n/n123456789abc`
- `ng_words.txt` に除外したいワードを1行ずつ記載
  - 例: `広告`
- 記事一覧の作者リンクを右クリックし、「この作者を非表示」を選ぶと、その作者がローカル保存の除外リストに追加されます
- https://note.com/* を開くと、対象カードから条件に合致するものが自動的に非表示になります

仕様補足
- 対象カードは `m-largeNoteWrapper__card` を含む要素、新デザインの `div.flex.w-full.rounded-lg.bg-surface-normal` / `div.flex.w-full.rounded.bg-surface-normal`、モバイルの `figure` 要素でクラス名に `o-horizontalTimeLineNote` を含むものです
- 有料記事の判定は「有料/会員限定/販売中/月額」などの文言や価格表記をヒューリスティックに検出します
- 指定の鍵SVGアイコンは、見出しの先頭にあり、かつ `path` の `d` 属性が一致する場合に検出します
- 一覧カード内のリンク順が変わっても、記事URLやプロフィールURLから著者名を優先的に判定します
- 優先順位は `allow_urls.txt` > 外部リンク > 鍵SVGアイコン > `ng_words.txt` > `excludes.txt` > `allow_paid_users.txt` です
- NGワードはすべての記事カードに部分一致で適用されます
- NGワードの判定では、英字の大文字・小文字および全角・半角を区別しません
- 右クリックで追加した除外ユーザーは `chrome.storage.local` に保存され、`excludes.txt` とマージして判定します
- 同一著者の記事は、除外ルールを通過した一覧の先頭の1記事だけ表示します。著者本人のプロフィールページと `allow_urls.txt` に指定した記事は例外です
- MutationObserver でカードの追加・削除、カード内のリンク・本文・判定用属性の変更を監視します。無限スクロールや著者情報の遅延読み込みにも、初期表示と同じルールを適用します
- 連続したDOM更新は50ミリ秒でまとめ、現在の一覧順で著者数を数え直します。表示記事の削除・除外時には、同じ著者の残りの記事を再判定します
- 各設定用 `.txt` を更新した場合は、拡張の再読み込みを行ってください

ファイル構成
- `manifest.json`: 拡張マニフェスト（MV3）
- `background.js`: 右クリックメニューとローカル保存の管理
- `content.js`: 記事カード検出・非表示ロジック
- `excludes.txt`: 除外ユーザー名（1行1件）
- `allow_paid_users.txt`: 有料記事の表示を許可するユーザー名（1行1件）
- `allow_urls.txt`: 全表示対象の記事URL（1行1件）
- `ng_words.txt`: NGワード（1行1件）
- `test/content.test.js`: 非同期読み込み・重複表示などの回帰テスト

開発用テスト
- Node.js 24以降を使用し、`npm ci` の後に `npm test` を実行してください
- テストではjsdomで記事一覧のDOM更新を再現します。拡張機能の利用時にはNode.jsやnpmは不要です
