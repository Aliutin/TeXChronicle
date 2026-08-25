# TeXChronicle —— ユーザーガイド

[English](../USER-GUIDE.md) · [简体中文](USER-GUIDE.zh-CN.md) · **日本語** · [한국어](USER-GUIDE.ko.md) · [Español](USER-GUIDE.es.md) · [Français](USER-GUIDE.fr.md) · [Deutsch](USER-GUIDE.de.md) · [Português](USER-GUIDE.pt.md)

![TeXChronicle ワークスペース](../images/workspace.png)

## 日常の使い方

1. 論文プロジェクトの `.mcp.json` にサーバーを追加し(README 参照)、Claude Code を再起動します。
   またはプラグインを入れてスラッシュコマンドを使います(下記)。
2. Claude に *「render a preview」* と頼む(または `/texchronicle` を実行)。**ワークスペース**が
   開きます:左に**ファイルツリー＋ソースエディタ**、中央に**ライブ PDF**、右に **Comments**
   (上部バーの 💬 **Comments** ボタンで切替)。
3. 以降、PDF はライブのままです。あなた自身のエディタでの保存も Claude の編集も自動で再コンパイル
   されます。内蔵エディタでは **Ctrl+S** / **Recompile** で再ビルド(30 秒ごとに自動保存されますが、
   再コンパイルはされません)。

## スラッシュコマンド(プラグイン)

一度インストールすれば —— `/plugin marketplace add Aliutin/TeXChronicle` のあと
`/plugin install texchronicle` —— 最小限のタイピングで操作できます:

- **`/texchronicle`** —— コンパイルしてワークスペースを開く。
- **`/ai-review [skill]`** —— スキルで論文を査読(既定は `academic-paper-revision`、任意のスキル名も可)し、
  承認用のコメントを投稿。
- **`/address-comments`** —— 承認済みコメントを解決(ループ化:`/loop 60s /address-comments`)。
- ⚡ **`/ultra-agents [skill] [depth]`** —— 完全自動:査読・自動承認・修正を繰り返す。最大 `depth`
  ラウンド(既定 2)、あるラウンドで新規指摘がゼロなら早期停止。ラウンド間の承認は挟まない ——
  それが目的でありリスクでもあります。[`AGENT-LOOP.ja.md`](AGENT-LOOP.ja.md#ultra-agents-) 参照。

### ツールごとに 1 コマンド

各 MCP ツールには**同名**のスラッシュコマンドがあり、どの単一ステップもコマンド 1 つで実行できます。
教えるルールは一言:**ツールが `X` なら `/X` と打つ**。

| これを打つ | 実行ツール | 内容 |
| --- | --- | --- |
| `/render_preview` | `render_preview` | 論文をコンパイルしてライブプレビューを開く/更新。 |
| `/check_comments` | `check_comments` | 承認済みコメントを編集指示として一覧表示(まだ編集しない)。 |
| `/resolve_comment [id] [メモ]` | `resolve_comment` | 編集後に解決としてマーク;コメントが**緑**になり確認待ち。 |
| `/add_comment ["引用"] [メモ]` | `add_comment` | 該当箇所にコメントをアンカーし、承認/却下できるように。 |
| `/reply_to_comment [id] [本文]` | `reply_to_comment` | コメントにスレッド返信を追加。 |
| `/show_diff [checkpoint]` | `show_diff` | 並列ビジュアル差分を画像で表示(現在の変更か checkpoint)。 |
| `/list_checkpoints [limit]` | `list_checkpoints` | 直近のチェックポイントを sha 付きで表示 —— `/show_diff` に渡す sha を探すのに。 |

必ずしも打つ必要はありません —— 普通の言葉でも動きます(*「プレビューを表示」*、*「コメントに対応して」*)。
コマンドは速くて教えやすい省略形です。

## コメントループ(PDF 上で査読し、Claude がソースを直す)

1. **レンダリングされた PDF 上でテキストを選択** → 入力欄が出る → 直してほしいことを書く
   (「この段落を締めて」「この式が変」)→ **Add comment**。その箇所にアンカー付きハイライトが付き、
   右パネルに *accepted* 状態のカードが現れます。
2. Claude Code で *「address my comments」* と伝えます。Claude が `check_comments` を呼び
   (各コメントにページ、正確な引用箇所、あなたの指示が付いてきます)、ソースを編集し、
   一行メモ付きで `resolve_comment` を呼びます。
3. PDF が再コンパイルされ、カードは Claude のメモ付きで *resolved ✓* に変わり、History タブに
   変更内容のチェックポイント差分が残ります。

LaTeX に触る必要はまったくありません —— あなたは文書を指し、Claude がソースを扱います。

## 査読ワークフロー(reviewer → あなたが承認 → author が解決)

agent にコメントを*提起*させつつ、自分もループに残ることもできます:

1. **Reviewer パス。** `/ai-review academic-paper-revision` を実行(任意の査読スキルでも可)。
   agent が論文を読み、問題ごとに `add_comment` を呼びます —— **Suggested** カード(PDF 上は紫の
   破線ハイライト)として現れ、**reviewer** または **defender** のタグが付きます。
2. **あなたが承認。** Comments パネルで、賛成するものを **Accept**(実行可能な *accepted* になります)、
   残りを **Reject**、または自分で追加します。放置したい? **Auto-accept reviewer suggestions
   (copilot)** にチェックを入れると、すべての提案が自動で承認されます。
3. **Author が解決。** `/address-comments` を実行(ループ化も可)。author は承認済みの各コメントを
   そのソース位置で編集し、メモ付きで解決済みにします。

コメントには**返信スレッド**があります(解決前にあなたと agent が議論できます)。Claude が解決すると、
そのハイライトは**緑**になり(編集は完了、*あなた*の確認待ち)、カードは *Resolved* リストへ移動します。
確認は一件ずつです:編集を確認したら **Close** を押すと緑のハイライトが消えます —— これが「人間が確認した」
ステップなので、色は溜まっていくのではなく確認するそばから消えていきます。**clear all** で一括クローズも可能。

### ハイライトがテキストから少しずれることがある理由

ハイライトは pdf.js の見えない*テキストレイヤー*(選択に使われるのと同じ幾何情報)から描かれます。
これはキャンバス上でグリフが実際に描画される位置を行単位で近似したものなので、枠がわずかにずれることが
あり、拡大するとより目立ちます。この小さなズレは本質的なもので、見た目だけの問題です。Claude が段落を
編集して PDF が再フローした後に起きていた大きなズレを避けるため、TeXChronicle は**再コンパイルのたびに
ハイライトを現在のテキストへ再アンカー**します(コメントの引用の先頭と末尾のフレーズを照合)。
古い座標に固定するのではないので、途中の語が変わってもテキストに追随します。段落が削除されたり
原型をとどめないほど書き換えられた場合は、最後に分かっていた位置にフォールバックします。

## ビジュアル(WYSIWYG)モード

エディタバーで **Code / Visual** を切り替えます。ビジュアルモードは文書をその場で描画します ——
`\section`/`\textbf`/`\emph`、`$…$` と `\begin{equation}` の数式(KaTeX 経由)、リスト、`\cite` チップ、
リンク —— 同時にプリアンブルを淡く表示します。任意の要素をクリックすると元の LaTeX が現れて編集できます。
同じファイルの上に重ねた装飾レイヤーなので、ソースが書き換わることはありません。**⏎ Wrap** は長い行を
折り返します(改行なしで書かれた LaTeX 向け)。

## ファイルツリー

**FILES** パネルは完全なツリーです:フォルダを展開し、ファイルをクリックして切り替え、
**+ File / + Folder** や各行のリネーム/削除が使えます。下の仕切りをドラッグしてサイズ変更できます。

## ソースエディタ

左パネルの **Source** タブは、プロジェクトのテキストファイルを CodeMirror の LaTeX エディタで一覧します。
**Ctrl+S**(または Save)でディスクに書き込むと —— watcher が再コンパイルし PDF が更新されます。
まさに Typst のエディタループと同じです。自分のエディタを使いたい? どこからの保存でも同じループが走ります。

### 会話の中で差分を見る

Claude に *「show me the diff」*(または *「show the diff of the last checkpoint」*)と頼むと、
`show_diff` ツールを使って**並列差分を画像としてチャット内に**返します。これが存在するのは、
Claude Code 自身に差分ビューアがないからです —— Claude がただ `git diff` を実行すると、その出力を
テキストとして取り込み要約してしまいます。`show_diff` は実際のビジュアルな分割表示を返します。
(*レンダリングされた PDF の隣で*同じ差分を見たいならブラウザの History パネルを、ターミナルでの
分割表示なら [delta](https://github.com/dandavison/delta) を設定した `git diff` を使ってください。)

## 論文を Overleaf に持っていく

環境に応じて 3 つの方法があります。このツールはあなたの資格情報なしに Overleaf へプッシュすることは
できないので、いずれもあなたが主導権を握る形です。

### 1. きれいな zip をアップロード(誰でも使える)

**⬆ Export .zip** をクリック。ビルド入力だけを含む zip が得られます —— `.tex`、`.bib`、
`.cls`/`.sty`/`.bst`、図版 —— ビルド成果物(`.aux`、`.log`、コンパイル済み PDF)、`.git/`、
`node_modules/` は除外されます。Overleaf で **New Project → Upload Project** し、zip をドロップ。

これが確実で普遍的な経路です —— アカウント連携も公開リポジトリも不要。

### 2. ワンクリック「Open in Overleaf」(公開 GitHub リポジトリ)

プロジェクトが git リポジトリで、GitHub の `origin` が**公開**なら、ツールバーに
**Open in Overleaf ↗** が表示されます。クリックすると Overleaf がリポジトリの現在ブランチの
アーカイブを直接インポートします —— 新規プロジェクトがワンクリックで。公開リポジトリでしか動かないのは、
Overleaf のサーバーがインターネット越しにアーカイブを取得するためです。

### 3. 既存の Overleaf プロジェクトに同期(Overleaf Premium —— Git bridge)

Overleaf Premium は各プロジェクトを git リモートとして公開します。設定は一度だけ、あなた自身で
行ってください(トークンはこのツールが決して扱わない資格情報です):

```bash
git remote add overleaf https://git.overleaf.com/<your-project-id>
# git にパスワードを聞かれたら Overleaf の git トークンを入力
git push overleaf <branch>
```

以降、更新の公開は `git push overleaf` だけ —— Claude に実行させることもできます。

## パッケージの対応状況

WASM エンジンが同梱するのは TeX Live の**サブセット**(basic + recommended + extra)です。
一般的なパッケージのほとんどは含まれています。よくある欠落のいくつかは自動で処理されます:
- `algorithm`/`algorithmicx` ファミリーと `multirow` —— 本物の `.sty` を同梱(逐語、LPPL)し注入します。
- `bbm` —— 小さな**プレビュー用シム**が `\mathbbm` を近似します(文字は `\mathbb`、`\mathbbm{1}` の
  指示関数は簡易的な二重線の 1)。これで論文は描画され続けます。

それ以外でサブセット外かつフォント依存のものは `File '<pkg>.sty' not found` で失敗します。その場合は
パッケージの `.sty`(とフォント)をプロジェクトに置くか、プリアンブルを調整してください。いずれにせよ
Overleaf での最終コンパイルは本物のパッケージを使います —— ローカルプレビューは近似です。

## 注記

- コンパイルされた PDF は Overleaf の出力の近似(WASM 経由の現行 TeX Live)であり、ビット単位で
  一致する保証はありません。大多数の論文では十分正確ですが、最終的には必ず提出先(Overleaf や
  投稿システム)で最終コンパイルを行ってください。
- 変更履歴は隠し git ref(`refs/latex-preview/checkpoints`)に保存され、あなたのブランチ、`git log`、
  作業ツリーには一切触れません。フォルダが git リポジトリでない場合、TeXChronicle はその ref を
  プロジェクト内の `.latex-preview/history.git` にある自前のリポジトリで保持します——履歴は
  フォルダと一緒に移動・コピー・削除され、そこで `git` を実行しても「リポジトリではない」ままです。
