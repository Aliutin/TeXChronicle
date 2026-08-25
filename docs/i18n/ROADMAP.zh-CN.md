# 路线图

[English](../ROADMAP.md) · **简体中文** · [日本語](ROADMAP.ja.md) · [한국어](ROADMAP.ko.md) · [Español](ROADMAP.es.md) · [Français](ROADMAP.fr.md) · [Deutsch](ROADMAP.de.md) · [Português](ROADMAP.pt.md)

## 已实现:TeXChronicle 自身状态的安全并发使用

每个连接到项目 `texchronicle` MCP server 的 Claude Code 会话都会启动**自己独立的进程**(stdio MCP = 每个客户端一个子进程)——所以两个会话同时改同一篇论文,内存里没有任何共享状态。原本没有任何机制阻止它们在同一批磁盘文件上互相竞争。

- **跨进程锁**(`src/lock.ts`)——在 `.latex-preview/.lock` 位置的排他锁文件,通过原子创建(`O_EXCL`)获取,带失效恢复(持有者进程已死,或锁存在超过 30 秒,会被自动清除,这样崩溃的 agent 不会永久卡住其他人)。
- **保护的范围**:`add_comment` / `resolve_comment` / `reply_to_comment` / 拒绝并删除(`commentsStore.ts` 所有的写操作)以及 checkpoint 的创建/恢复(`createCheckpoint`、`restoreCheckpoint`、`restoreFile`)——现在整个"读-改-写"过程都作为**一个跨进程的临界区**运行,而不是读→改→写之间毫无互斥。
- **原子写入**——`comments.json` 先写到临时文件再重命名覆盖目标文件,所以并发读取(读取本身不加锁——读从来不需要阻塞)永远不会看到写了一半的文件。
- 已验证:两个真正独立的 OS 进程同时高频调用 `add_comment`,一条写入都不会丢;一个被崩溃进程留下的锁,会在 100ms 内被清除,而不是卡满超时时间。

**这个方案覆盖不到的**:两个 agent 通过普通的文件编辑工具**同时改同一个** `.tex` 文件。这个写入直接落到磁盘上,完全绕开我们的 MCP server——我们加的锁够不着它。如果你今天就想试试两个 agent 同时跑,让它们只碰**不重叠的文件**(一个只动 `intro.tex`,另一个只动 `related-work.tex`),直到下面这个里程碑上线。

## 下一个里程碑:真正的 multi-agent(并行编辑)

reviewer、author、defender 三个 agent **同时**处理同一篇论文,真正并发地改文字——不只是通过共享的锁轮流干活。

- **方向**:通过 git worktree/分支实现每个 agent 的隔离。每个 agent 在自己的 worktree 里独立工作、独立编译;有一个协调步骤(人工审核,或者一个专门的整合 agent)把各分支合并回项目。
- **需要做的**:worktree 生命周期管理(每次 agent 运行创建,合并/放弃后清理)、合并冲突的交互设计(段落级别的冲突是内容问题,不只是 git 问题——怎么呈现给用户需要好好想清楚)、大概率还需要每个分支各自的 PDF 预览或者"先合并再重新编译"这一步,以及启动/追踪并行 agent 运行的新 MCP 工具/命令。
- **尚未开始**。不管这个里程碑最后做不做,上面那把锁都是实打实的安全网——它让"不小心开了第二个 Claude Code 会话在同一个项目上"从"静默丢数据的陷阱"变成"今天就是安全的"。
