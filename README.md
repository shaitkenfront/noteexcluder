noteexcluder

概要
- note.com 上でクラス名に `m-largeNoteWrapper__card` を含むカードを対象とし、以下を非表示にする Chrome 拡張です。
  - 有料設定のある記事
  - 除外設定ファイル（ユーザー名リスト）に含まれるユーザーの記事

使い方
- Chrome で拡張機能を開き、デベロッパーモードを有効化
- 「パッケージ化されていない拡張機能を読み込む」から本フォルダを選択
- `excludes.txt` に除外したいユーザー名を1行1ユーザーで記載
  - 例: `foobar` / `@foobar` / `https://note.com/foobar`
- https://note.com/* を開くと、対象カードから条件に合致するものが自動的に非表示になります

仕様補足
- 対象カードは `m-largeNoteWrapper__card` を含む要素に限定しています
- 有料記事の判定は「有料/会員限定/販売中/月額」などの文言や価格表記をヒューリスティックに検出します
- DOM 変化（無限スクロール等）に対応するため、MutationObserver で追加されたカードも逐次処理します
- `excludes.txt` を更新した場合は、拡張の再読み込みを行ってください

ファイル構成
- `manifest.json`: 拡張マニフェスト（MV3）
- `content.js`: 記事カード検出・非表示ロジック
- `excludes.txt`: 除外ユーザー名（1行1ユーザー）
