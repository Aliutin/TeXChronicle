# エージェントループ —— トリガーとしてのコメント

[English](../AGENT-LOOP.md) · [简体中文](AGENT-LOOP.zh-CN.md) · **日本語** · [한국어](AGENT-LOOP.ko.md) · [Español](AGENT-LOOP.es.md) · [Français](AGENT-LOOP.fr.md) · [Deutsch](AGENT-LOOP.de.md) · [Português](AGENT-LOOP.pt.md)

ワークスペースは **PDF 上のコメント**を **Claude へのタスク**に変えます。あなたは文書を指し示し、Claude がソースを扱う。このページでは、それをループとして回し、あなたが残したコメントを Claude が次々に処理していく方法を説明します——論文が自分で進み、あなたは履歴を眺めるだけ、という状態への第一歩です。

## 1 パスの流れ（手動）

1. ワークスペースで、レンダリングされた PDF 上のテキストを選択してコメントを残します
   （例：*「この段落を締めて」*、*「この主張には引用が要る」*）。
2. Claude Code で **「address my comments」** と伝えます。
3. Claude が `check_comments` を呼び、承認済みの各コメントを**位置情報付きの作業項目**として取得します：

   ```
   2 accepted comments — edit each at its source location per the instruction,
   then call resolve_comment with its id and a one-line note:

   [id: a1b2c3] p.1 — "the largest of twelve predefined contrasts is 7.2 percentage points"
     ↳ source: main.tex:37
     → State the exact p-value here.

   [id: d4e5f6] p.2 — "Judges deployed across languages should be audited"
     ↳ source: main.tex:44
     → Soften this to a recommendation, not a mandate.
   ```

4. 各項目について、Claude はその `ファイル:行` でソースを開いて編集し、`resolve_comment(id, note)` を
   呼びます。保存すると再コンパイルと git チェックポイントが自動で走るので、PDF が更新され、
   変更は **History** で差分として確認できます。
5. 各カードは Claude のメモ付きで **解決済み ✓** に切り替わります。あなたが言い直す必要はありません。

## ループとして回す（放置運用）

Claude Code の `/loop` でコメント受信箱を見張らせます。論文プロジェクト内で：

```
/loop 60s Address my PDF comments: call check_comments; for each accepted item, edit the
source at its location per the instruction and call resolve_comment with a one-line note.
If there are no accepted comments, do nothing this pass.
```

- 約 60 秒ごとに Claude が新しいコメントを確認して片付けます。コメントを残して席を立ち、戻ってくると
  カードは解決済み、チェックポイントの差分も残っています。
- `check_comments` が「No accepted comments」を返すのはきれいな no-op なので、空振りのパスは安価です。
- ループはいつでも止められます。やったことはすべて git 履歴に残っています。

## なぜ「見守る」だけでよく、「子守り」が要らないのか

- **追跡可能** — 各パスは History で開けるチェックポイントとカード上の解決メモを残すので、
  *何が*変わり*なぜ*変わったかを常に確認できます。
- **取り消し可能** — チェックポイントは隠し git ref 上にあり、あなたの `git log` や作業ツリーは
  一切触られません。どの変更も通常の方法で戻せます。
- **範囲が限定的** — Claude はコメントが指す箇所しか編集しません。受信箱が空なら編集もゼロです。

## reviewer → 人間の承認 → resolver ワークフロー

コメント受信箱には 3 つの状態があり、査読サイクル全体を繋ぎます：

`suggested`（提案）→（人間が承認）→ `accepted`（承認済み）→（author ループ）→ `resolved`（解決済み）

1. **Reviewer がコメントを投稿。** あなたの査読スキルで論文に赤入れさせます——問題ごとに
   `add_comment(quote, comment)` を呼び、**提案**として着地します（PDF 上の紫の破線ハイライト、
   *Suggested* セクションのカード）：

   ```
   Review my paper using my installed academic-review skill.
   For each issue, call add_comment
   with the exact quoted passage and your comment. Don't edit the source yet.
   ```

2. **人間が査読を承認。** *Suggested* セクションで、納得できるものを **Accept**（実行可能な
   `accepted` になります）、残りを **Reject**、または自分で編集・追加します。`check_comments` は
   意図的に `suggested` の項目を無視します——author はあなたが承認していない提案には決して手を
   出しません。

   - 放置運用したい？ Comments パネル上部の **Auto-accept reviewer suggestions（copilot）** を
     オンにすると、提案が届いた瞬間にすべて承認されます。（完全ヘッドレスな agent は
     `add_comment(..., accepted: true)` で直接実行可能なコメントを投稿することもできます。）

3. **Author ループが解決。** 上のループを回すと、`accepted` のコメントを拾い、特定された各
   `ファイル:行` で編集し、再コンパイルし、メモ付きで解決していきます。

4. **すべてが記録される。** 承認・編集・解決のたびにチェックポイントとメモが残るので、
   reviewer→author のラウンド全体が **History** で追跡できます。

## Ultra-agents ⚡

> [!CAUTION]
> これは TeXChronicle で最も強力なコマンドであり、最も監督が少ないコマンドでもあります——設計上、
> ラウンドごとのあなたの承認はありません。大きな `depth` で実行する前に、このセクションを
> 最後まで読んでください。

`/ultra-agents [skill] [depth]` はステップ 2 の人間による承認を**完全に取り除きます**——reviewer が
`add_comment(..., accepted: true)` で投稿するので、指摘された瞬間から実行可能になり、author が
直後に解決します。そしてそれを繰り返します：**いま編集されたばかりの**論文をもう一度査読し、
また直す、を最大 `depth` ラウンド（既定 **2**）。あるラウンドで新しい指摘がゼロになった時点で
停止します——収束した論文が残りの回数を無駄に消費することはありません。

これは草稿を前に進める最速の方法であり、最も監督の薄い方法でもあります——ラウンドごとの
チェックポイントは*あなた*のためではなく、ツールのためだけに存在します。`depth` が 5 を超えると
確認を求めて一度停止します。無人編集としてはかなりの量を、軽い気持ちで引き受けることになるからです。
どの depth を選ぶにせよ、実行はこうです：

```
/ultra-agents academic-paper-revision 3
```

終了時（depth に達したか、早期収束したか）には `list_checkpoints` を呼び、**ラウンドごとにまとめた
要約**を提示します——何が指摘され、何が変わり、各ラウンドに対応するチェックポイントの sha は何か。
これにより `/show_diff <sha>` で任意のラウンドへ直行でき、History を探し回る必要がありません。
安全網はここの他の機能と同じです：各ラウンドは依然として通常のチェックポイントで、History タブから
確認・取り消し（ラウンド全体でもファイル単位でも）ができます。つまり**回復できるのは損害であって、
時間ではありません**——脱線したラウンドを見張るものは、あなたが要約を読むこと以外に何もありません。
だからこれは、あとで自分で確認するつもりの草稿に使ってください。手を入れずにそのまま出す版に
使うものではありません。

これは「reviewer 1 人 + author 1 人、間に人間」という構成です。複数の Claude Code セッションは
すでに同じプロジェクトで同時に作業でき、コメントやチェックポイントを壊すことはありません
（各書き込みはクロスプロセスロックの下で実行されます——
[`ROADMAP.ja.md`](ROADMAP.ja.md) 参照）。ただし依然として順番待ちであり、本当の並列編集ではありません。
真の並行 multi-agent（reviewer / author / defender がそれぞれ自分の git ブランチで、調整しながら
進む）は次のマイルストーンです——[`ROADMAP.ja.md`](ROADMAP.ja.md) を参照。
