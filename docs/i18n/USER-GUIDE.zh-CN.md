# TeXChronicle —— 用户手册

[English](../USER-GUIDE.md) · **简体中文** · [日本語](USER-GUIDE.ja.md) · [한국어](USER-GUIDE.ko.md) · [Español](USER-GUIDE.es.md) · [Français](USER-GUIDE.fr.md) · [Deutsch](USER-GUIDE.de.md) · [Português](USER-GUIDE.pt.md)

![TeXChronicle 工作区](../images/workspace.png)

## 日常使用

1. 把 server 加到论文项目的 `.mcp.json`(见 README),重启 Claude Code。
   或者安装插件用 slash 命令(见下)。
2. 让 Claude *"render a preview"*(或运行 `/texchronicle`)。**工作区**会打开:左边是
   **文件树 + 源码编辑器**,中间是**实时 PDF**,右边是 **Comments**(用顶栏的 💬 **Comments** 按钮切换)。
3. 从此 PDF 保持实时。你自己编辑器的保存和 Claude 的修改都会自动重新编译;
   在内置编辑器里按 **Ctrl+S** / **Recompile** 才重新编译(它每 30 秒自动保存你的工作,但不重新编译)。

## Slash 命令(插件)

安装一次 —— `/plugin marketplace add Aliutin/TeXChronicle` 然后 `/plugin install texchronicle` ——
就能用最少的打字量驱动它:

- **`/texchronicle`** —— 编译并打开工作区。
- **`/ai-review [skill]`** —— 用某个 skill 审阅论文(默认 `academic-paper-revision`,
  任意 skill 名都行),留下评论供你接受。
- **`/address-comments`** —— 解决你已接受的评论(可循环:`/loop 60s /address-comments`)。
- ⚡ **`/ultra-agents [skill] [depth]`** —— 全自动:审阅、自动接受、修改、重复,最多 `depth` 轮
  (默认 2),某一轮没发现新问题就提前停止。轮与轮之间不经过你确认——这既是意义也是风险。见
  [`AGENT-LOOP.zh-CN.md`](AGENT-LOOP.zh-CN.md#ultra-agents-)。

### 每个工具一个命令

每个 MCP 工具都有一个**同名**的 slash 命令——任何单步都是一个命令的事。要教别人的规则一句话:
**工具叫 `X`,就打 `/X`**。

| 打这个 | 调用工具 | 作用 |
| --- | --- | --- |
| `/render_preview` | `render_preview` | 编译论文,打开/刷新实时预览。 |
| `/check_comments` | `check_comments` | 列出你已接受的评论(作为修改指令,先不改)。 |
| `/resolve_comment [id] [说明]` | `resolve_comment` | 改完后标记完成;评论变**绿**等你复核。 |
| `/add_comment ["引文"] [说明]` | `add_comment` | 把评论锚定到某段文字,供你接受/拒绝。 |
| `/reply_to_comment [id] [内容]` | `reply_to_comment` | 给某条评论追加线程回复。 |
| `/show_diff [checkpoint]` | `show_diff` | 并排可视化 diff(图片;当前改动或某个 checkpoint)。 |
| `/list_checkpoints [limit]` | `list_checkpoints` | 列出最近的 checkpoint 及其 sha——找一个传给 `/show_diff`。 |

其实不打命令也行——直接说人话同样有效(*"渲染预览"*、*"处理我的评论"*)。命令只是更快、更好教的简写。

## 评论循环(在 PDF 上审阅,Claude 改源码)

1. **在渲染出的 PDF 上选中文字** → 弹出编辑框 → 写你想要的改动("把这段收紧"、"这个公式看着不对")
   → **Add comment**。这段文字会获得一个锚定的高亮;右侧面板出现一张 *accepted* 状态的卡片。
2. 在 Claude Code 里说 *"address my comments"*。Claude 调用 `check_comments`(每条评论都带页码、
   精确的引用原文和你的指令),修改源码,再调用 `resolve_comment` 附上一行说明。
3. PDF 重新编译,卡片翻转为 *resolved ✓* 并带上 Claude 的说明,History 标签页里存着这次改动的
   checkpoint diff。

你完全不用碰 LaTeX——你指着文档,Claude 处理源码。

## 审阅工作流(reviewer → 你把关 → author 解决)

你也可以让 agent 来*提出*评论,同时把自己留在循环里:

1. **Reviewer 阶段。** 运行 `/ai-review academic-paper-revision`(或指向任意审阅 skill)。
   agent 读论文,对每个问题调用 `add_comment` —— 它们显示为 **Suggested** 卡片
   (PDF 上是紫色虚线高亮),标记 **reviewer** 或 **defender**。
2. **你把关。** 在 Comments 面板里,**Accept** 你认可的(它们变成可操作的 *accepted*),
   **Reject** 其余的,或者自己加。想彻底放手?勾选 **Auto-accept reviewer suggestions (copilot)**,
   每条建议都会自动被接受。
3. **Author 解决。** 运行 `/address-comments`(或循环运行)。author 在每条已接受评论的源码位置
   做修改,并附上说明标记为已解决。

评论带**回复线程**(你和 agent 可以在解决之前讨论)。当 Claude 解决一条时,它的高亮变**绿**
(改动已完成,等*你*复核),卡片移到 *Resolved* 列表。复核是一条一条来的:检查完改动后点
**Close**,绿色高亮就消失——这就是"人工已确认"这一步,所以颜色会随着你的复核逐渐清空,而不是堆积。
**clear all** 可以批量关闭。

### 为什么高亮有时会跟文字稍微对不齐

高亮是根据 pdf.js 那层看不见的*文字层*画出来的(和选中文字用的是同一套几何信息),它对字形在画布上
实际绘制位置是按行做的近似——所以框可能差那么一点点,放大时更明显。这个小偏移是固有的,纯视觉问题。
为了避免以前那种"Claude 改完一段、PDF 重排后高亮大幅漂移"的情况,TeXChronicle 会在**每次重新编译时把
高亮重新锚定到当前文字上**(通过匹配评论引文的首尾短语),而不是钉死在旧坐标上——所以即使中间的词
被改了,高亮也会跟着文字走。如果一段被删掉或改得面目全非,高亮会退回到它最后已知的位置。

## 可视化(WYSIWYG)模式

在编辑器工具栏切换 **Code / Visual**。可视化模式会就地渲染文档 —— `\section`/`\textbf`/`\emph`、
`$…$` 和 `\begin{equation}` 数学公式(通过 KaTeX)、列表、`\cite` 标签、链接 —— 同时把导言区调暗。
点击任意元素可以显示它的原始 LaTeX 并编辑。它只是同一个文件之上的一个装饰层,永远不会改动你的源码。
**⏎ Wrap** 用于折行显示超长行(适合写成一行没有换行的 LaTeX)。

## 文件树

**FILES** 面板是一棵完整的树:展开文件夹、点击文件切换,用 **+ File / + Folder**,或某一行的
重命名/删除。拖动它下方的分隔条可以调整高度。

## 源码编辑器

左侧面板的 **Source** 标签页在一个 CodeMirror LaTeX 编辑器里列出项目的文本文件。
**Ctrl+S**(或 Save)写入磁盘 —— watcher 重新编译,PDF 刷新,和 Typst 的编辑器循环一模一样。
更喜欢用自己的编辑器?从任何地方保存都会触发同一个循环。

### 在对话里直接看 diff

让 Claude *"show me the diff"*(或 *"show the diff of the last checkpoint"*),它会用 `show_diff`
工具**直接在聊天里返回一张并排 diff 图片**。之所以有这个功能,是因为 Claude Code 自己没有 diff
查看器 —— 如果 Claude 只是跑 `git diff`,它会把文本捕获下来然后总结一遍。`show_diff` 给你的是真正
的可视化分栏。(想在*渲染的 PDF 旁边*看同一个 diff,用浏览器的 History 面板;想在终端里看分栏,
用配好 [delta](https://github.com/dandavison/delta) 的 `git diff`。)

## 把论文导入 Overleaf

有三种方式,取决于你的情况。这个工具在没有你的凭据的情况下无法替你推送到 Overleaf,所以这几种方式
都让你保持控制权。

### 1. 上传一个干净的 zip(所有人都适用)

点 **⬆ Export .zip**。你会得到一个只包含编译输入的 zip —— `.tex`、`.bib`、`.cls`/`.sty`/`.bst`
和图片 —— 编译产物(`.aux`、`.log`、编译出的 PDF)、`.git/` 和 `node_modules/` 都被排除在外。
在 Overleaf 里:**New Project → Upload Project**,把 zip 拖进去。

这是可靠、通用的路径 —— 不需要关联账号,也不需要公开仓库。

### 2. 一键 "Open in Overleaf"(公开的 GitHub 仓库)

如果你的项目是一个 git 仓库,且 GitHub 的 `origin` 是**公开的**,工具栏会显示
**Open in Overleaf ↗**。点击它会让 Overleaf 直接导入你仓库当前分支的归档 —— 一键新建项目。
它只对公开仓库有效,因为是 Overleaf 的服务器通过互联网去抓取那个归档。

### 3. 同步到已有的 Overleaf 项目(Overleaf Premium —— Git bridge)

Overleaf Premium 把每个项目暴露成一个 git remote。自己设置一次即可(你的 token 是一种凭据,
这个工具从不经手):

```bash
git remote add overleaf https://git.overleaf.com/<your-project-id>
# git 提示输入密码时,填你的 Overleaf git token
git push overleaf <branch>
```

设置完之后,发布更新就只是 `git push overleaf` —— 你可以让 Claude 帮你跑。

## 宏包覆盖情况

WASM 引擎自带的是 TeX Live 的一个**子集**(basic + recommended + extra)。大多数常用宏包都包含在内。
有几个常见的缺失被自动处理了:
- `algorithm`/`algorithmicx` 家族和 `multirow` —— 真实的 `.sty` 已被内置(逐字收录,LPPL 协议)并注入;
- `bbm` —— 一个小的**预览替身**近似实现了 `\mathbbm`(字母用 `\mathbb`,`\mathbbm{1}` 指示函数用一个
  简易的双线 1),这样论文依然能渲染出来。

其他不在子集内、且依赖字体的宏包会失败并报 `File '<pkg>.sty' not found`。遇到这种情况,把该宏包的
`.sty`(和字体)放进你的项目,或者调整导言区。无论如何,你在 Overleaf 上的最终编译用的是真实的宏包
—— 本地预览是一个近似。

## 说明

- 编译出的 PDF 是对 Overleaf 产物的近似(通过 WASM 的一个当前版本 TeX Live),不保证逐位一致。
  对绝大多数论文来说是准确的;最终一定要在你的目标平台(Overleaf 或投稿系统)上做一次最终编译。
- 修改历史存放在一个隐藏的 git ref(`refs/latex-preview/checkpoints`)里,永远不碰你的分支、
  `git log` 或工作树。如果这个文件夹不是 git 仓库,TeXChronicle 会把那条 ref 放在项目内
  `.latex-preview/history.git` 这个属于它自己的仓库里——所以历史会跟着文件夹一起移动、复制和删除,
  而在那里运行 `git` 依然会说这不是一个仓库。
