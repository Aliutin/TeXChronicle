# Agent 循环 —— 评论作为触发器

[English](../AGENT-LOOP.md) · **简体中文** · [日本語](AGENT-LOOP.ja.md) · [한국어](AGENT-LOOP.ko.md) · [Español](AGENT-LOOP.es.md) · [Français](AGENT-LOOP.fr.md) · [Deutsch](AGENT-LOOP.de.md) · [Português](AGENT-LOOP.pt.md)

工作区把**PDF 上的一条评论**变成**Claude 的一个任务**。你指向文档,Claude 处理源码。这一页讲怎么把这个过程跑成一个循环,让 Claude 持续处理你留下的评论——这是"论文自己动起来、你在旁边看历史记录"的第一步。

## 单轮流程(手动)

1. 在工作区里,选中渲染出来的 PDF 上的文字,留一条评论
   (比如"把这段收紧一点"、"这个论断需要加引用")。
2. 在 Claude Code 里说**"处理我的评论"**。
3. Claude 调用 `check_comments`,拿到每条已接受的评论,作为一个**带定位的工作项**:

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

4. 对每一条,Claude 在对应的 `file:line` 打开源码、做出修改,然后调用
   `resolve_comment(id, note)`。保存会自动触发重新编译和一个 git checkpoint,
   PDF 刷新,改动也能在 **History** 里看到 diff。
5. 每张卡片翻转成**已解决 ✓**,附上 Claude 的说明。不用你再重复说一遍。

## 跑成一个循环(撒手不管)

用 Claude Code 的 `/loop` 持续盯着评论收件箱。在你的论文项目里:

```
/loop 60s Address my PDF comments: call check_comments; for each accepted item, edit the
source at its location per the instruction and call resolve_comment with a one-line note.
If there are no accepted comments, do nothing this pass.
```

- 每隔约 60 秒,Claude 检查有没有新评论并清空它们。留个评论,走开,回来时卡片已经解决,checkpoint diff 也在。
- `check_comments` 返回"没有已接受的评论"就是一次干净的空跑,所以空闲轮次的成本很低。
- 随时可以停掉循环;它做过的一切都在你的 git 历史里。

## 为什么这个可以"看着"而不用"看管"

- **可追溯**——每一轮都会留下一个 checkpoint(在 History 里能打开)和卡片上的解决说明,你随时能看到*改了什么*、*为什么改*。
- **可撤销**——checkpoint 存在一个隐藏的 git ref 上;你自己的 `git log` 和工作树完全不受影响。想撤销就照常规方式撤销。
- **范围受限**——Claude 只在评论指向的地方改动;收件箱空了就意味着不会有任何改动。

## reviewer → 人工把关 → resolver 工作流

评论收件箱有三种状态,串起一整个审阅周期:

`suggested`(建议)→(人工接受)→ `accepted`(已接受)→(author 循环)→ `resolved`(已解决)

1. **Reviewer 提出评论。** 让 Claude 用你的审阅 skill 去标注论文——每发现一个问题就调用
   `add_comment(quote, comment)`,落地成一条**建议**(PDF 上的紫色虚线高亮,Comments 面板里 *Suggested* 分区的一张卡片):

   ```
   Review my paper using my installed academic-review skill.
   For each issue, call add_comment
   with the exact quoted passage and your comment. Don't edit the source yet.
   ```

2. **人工给审阅把关。** 在 *Suggested* 分区里,把你认可的评论点 **Accept**(它们会变成可操作的
   `accepted`),其余的 **Reject**,或者自己编辑/新增。`check_comments` 有意忽略
   `suggested` 状态的条目——author 永远不会处理你没接受的建议。

   - 想彻底放手?打开 Comments 面板顶部的 **Auto-accept reviewer suggestions(copilot)**,
     每条建议一到就自动被接受。(完全无人值守的 agent 也可以直接用
     `add_comment(..., accepted: true)` 发直接可操作的评论。)

3. **Author 循环负责解决。** 跑上面那个循环——它会取走 `accepted` 状态的评论,
   在每个定位到的 `file:line` 做修改,重新编译,并逐条附上说明标记为已解决。

4. **一切都被记录下来。** 每次接受、编辑、解决都会留下一个 checkpoint 加一条说明,
   所以整个 reviewer→author 的回合在 **History** 里都能追溯。

## Ultra-agents ⚡

> [!CAUTION]
> 这是 TeXChronicle 最强大的命令,也是监督最少的——按设计,轮与轮之间不经过你的确认。
> 在用较大的 `depth` 运行之前,请先读完这一整节。

`/ultra-agents [skill] [depth]` 把第 2 步里那道人工把关**彻底去掉**——reviewer
用 `add_comment(..., accepted: true)` 发出的每条评论都是即时可操作的,author
紧接着就解决它。然后循环重复:重新审阅**刚被改过**的论文,再改一轮,最多
`depth` 轮(默认 **2**),某一轮如果一条新意见都没提就立刻停止——一篇已经收敛的
论文不会白白跑满剩下的轮数。

这是推进草稿最快、也是监督最少的方式——没有给*你*的逐轮 checkpoint,只有给
工具自己的。如果你要的 depth 超过 5,它会先停下来让你确认,因为那意味着相当多的
无人值守改动,不该随手就设一个大数。不管你选哪个 depth,运行方式都是:

```
/ultra-agents academic-paper-revision 3
```

跑完之后(不管是跑满 depth 还是提前收敛停止),它会调用 `list_checkpoints`,
给你一份**按轮分组的总结**——每轮提了什么、改了什么、对应哪个 checkpoint 的
sha,这样 `/show_diff <sha>` 能直接跳到任意一轮,不用在 History 里翻找。安全网
跟这里其他功能是同一套:每一轮依然是普通的、可审查、可撤销的 checkpoint(整轮
或者按文件撤销都行)。这意味着**损失是可以恢复的,但时间不是**——除了你自己
读那份总结之外,没有任何东西会替你盯着"这一轮是不是跑偏了",所以拿它去跑你
准备事后会去检查的草稿,而不是马上要交出去、未经检查的版本。

这仍然是"一个 reviewer + 一个 author,中间站着一个人"的模式。多个 Claude
Code 会话已经可以安全地同时在同一个项目上工作,不会破坏评论或 checkpoint
(每次写操作都在一把跨进程锁下运行——见
[`ROADMAP.zh-CN.md`](ROADMAP.zh-CN.md)),但它们依然是轮流干活,不是真的并行编辑。
真正的并发 multi-agent(reviewer / author / defender 各自在自己的 git 分支上,
协调着轮流推进)是下一个里程碑——见 [`ROADMAP.zh-CN.md`](ROADMAP.zh-CN.md)。
