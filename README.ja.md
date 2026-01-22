# codex-transcriber

Codex のセッション JSONL を TUI で閲覧し Markdown に書き出すツールです

## README
- English README: `README.md`
- 日本語 README: `README.ja.md`

## 必要条件
- Node 18 以上

## セットアップ
```sh
npm install
```

## 起動
```sh
npm start
```

または

```sh
node src/cli.js
```

## 環境変数
- `CODEX_SESSIONS_DIR` で読み込み先を指定します
- 既定の読み込み先は `~/.codex/sessions` です

## キー操作
- Quit は `q`
- フォーカス切り替えは `Tab` で `1` は左 `2` は右
- 左ペインの移動は `j` `k` `g` `G` `f` `b` `ArrowUp` `ArrowDown`
- 左ペインのセッションを codex で再開するには `c`
- 右ペインのスクロールは `j` `k` `g` `G` `f` `b` `ArrowUp` `ArrowDown` `Ctrl+u` `Ctrl+d`
- 右ペインの表示をクリップボードにコピーするには `c`
- 表示切り替えは `m` で Markdown と Pretty を切り替え
- 書き出しは `e` で開始し `Enter` で保存 `Esc` でキャンセル

## 内部構成
- `src/cli.js` は Ink の `render` で `App` を起動します
- `src/app.js` は TUI 描画とセッション読み込みと書き出しを担当します

## セッション読み込み
- `CODEX_SESSIONS_DIR` 配下の JSONL を再帰的に探索します
- 各 file の 1 行目から `session_meta` を読み取ります
- `label` は `session_meta.timestamp` または file 名の日時から作成します
- 並び順は file の mtime を最優先に降順で並べます
- mtime が取れない場合は `session_meta.timestamp` と file 名の日時を使います

## 会話抽出
- JSONL を 1 行ずつ読み `event_msg` を優先して使います
- `event_msg` の `user_message` `agent_message` `assistant_message` を会話として扱います
- `response_item` の `message` をフォールバックとして使います
- `# AGENTS.md` `<environment_context>` `<permissions instructions>` `<INSTRUCTIONS>` で始まる行は除外します
- 画像がある場合は `[image N]` を user メッセージ末尾に追加します

## エクスポート
- 既定の出力先は `process.cwd()` 配下です
- ファイル名は session の id があれば id を使い それ以外は file 名を使います
- 出力は `### User` と `### Assistant` の Markdown 形式です
