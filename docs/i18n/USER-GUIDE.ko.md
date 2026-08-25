# TeXChronicle — 사용자 가이드

[English](../USER-GUIDE.md) · [简体中文](USER-GUIDE.zh-CN.md) · [日本語](USER-GUIDE.ja.md) · **한국어** · [Español](USER-GUIDE.es.md) · [Français](USER-GUIDE.fr.md) · [Deutsch](USER-GUIDE.de.md) · [Português](USER-GUIDE.pt.md)

![TeXChronicle 작업 공간](../images/workspace.png)

## 일상적인 사용

1. 논문 프로젝트의 `.mcp.json`에 서버를 추가하고(README 참고) Claude Code를 재시작합니다.
   또는 플러그인을 설치해 슬래시 명령을 씁니다(아래).
2. Claude에게 *"render a preview"* 라고 요청합니다(또는 `/texchronicle` 실행). **작업 공간**이
   열립니다: 왼쪽에 **파일 트리 + 소스 편집기**, 가운데에 **라이브 PDF**, 오른쪽에 **Comments**
   (상단 바의 💬 **Comments** 버튼으로 토글).
3. 이후로 PDF는 계속 라이브 상태입니다. 당신 편집기의 저장과 Claude의 수정 모두 자동으로
   재컴파일됩니다. 내장 편집기에서는 **Ctrl+S** / **Recompile**로 다시 빌드합니다(30초마다 자동
   저장되지만 재컴파일은 하지 않습니다).

## 슬래시 명령(플러그인)

한 번만 설치하면 — `/plugin marketplace add Aliutin/TeXChronicle` 다음
`/plugin install texchronicle` — 최소한의 타이핑으로 다룰 수 있습니다:

- **`/texchronicle`** — 컴파일하고 작업 공간 열기.
- **`/ai-review [skill]`** — 스킬로 논문 검토(기본값 `academic-paper-revision`, 임의 스킬 이름 가능)
  후 수락용 코멘트 게시.
- **`/address-comments`** — 수락된 코멘트 해결(루프: `/loop 60s /address-comments`).
- ⚡ **`/ultra-agents [skill] [depth]`** — 완전 자동: 검토, 자동 수락, 수정, 반복을 최대 `depth`
  회차(기본 2)까지. 한 회차에서 새로운 게 없으면 조기 종료. 회차 사이에 승인이 없음 — 그게 요점이자
  위험입니다. [`AGENT-LOOP.ko.md`](AGENT-LOOP.ko.md#ultra-agents-) 참고.

### 도구마다 명령 하나

모든 MCP 도구에는 **같은 이름**의 슬래시 명령이 있어 어떤 단계든 명령 하나로 실행됩니다.
가르칠 규칙 한 줄: **도구가 `X` 면 `/X` 입력**.

| 이렇게 입력 | 실행 도구 | 하는 일 |
| --- | --- | --- |
| `/render_preview` | `render_preview` | 논문을 컴파일하고 라이브 미리보기 열기/새로고침. |
| `/check_comments` | `check_comments` | 수락한 코멘트를 편집 지시로 나열(아직 편집 안 함). |
| `/resolve_comment [id] [메모]` | `resolve_comment` | 편집 후 완료 표시; 코멘트가 **초록색**으로 바뀌어 검토 대기. |
| `/add_comment ["인용"] [메모]` | `add_comment` | 해당 구절에 코멘트를 고정해 수락/거절할 수 있게. |
| `/reply_to_comment [id] [내용]` | `reply_to_comment` | 코멘트에 스레드 답글 추가. |
| `/show_diff [checkpoint]` | `show_diff` | 나란히 보는 시각적 diff 이미지(현재 변경 또는 checkpoint). |
| `/list_checkpoints [limit]` | `list_checkpoints` | 최근 checkpoint를 sha와 함께 표시 — `/show_diff`에 넘길 sha 찾기용. |

꼭 입력할 필요는 없습니다 — 평범한 말로도 됩니다(*"미리보기 렌더링"*, *"코멘트 처리해줘"*).
명령은 빠르고 가르치기 쉬운 단축일 뿐입니다.

## 코멘트 루프(PDF에서 검토하고 Claude가 소스를 수정)

1. **렌더링된 PDF에서 텍스트를 선택** → 입력창이 뜸 → 원하는 변경을 적음("이 문단 압축해줘",
   "이 수식이 이상해") → **Add comment**. 해당 구절에 고정된 하이라이트가 생기고, 오른쪽 패널에
   *accepted* 상태의 카드가 나타납니다.
2. Claude Code에서 *"address my comments"* 라고 말합니다. Claude가 `check_comments`를 호출하고
   (각 코멘트에 페이지, 정확한 인용 구절, 당신의 지시가 딸려옵니다), 소스를 수정한 뒤 한 줄 메모와
   함께 `resolve_comment`를 호출합니다.
3. PDF가 재컴파일되고, 카드는 Claude의 메모와 함께 *resolved ✓* 로 바뀌며, History 탭에 그 변경의
   체크포인트 diff가 남습니다.

LaTeX을 만질 필요가 전혀 없습니다 — 당신은 문서를 가리키고, Claude가 소스를 다룹니다.

## 검토 워크플로(reviewer → 당신의 승인 → author가 해결)

agent가 코멘트를 *제기*하게 하면서도 당신이 루프 안에 남을 수도 있습니다:

1. **Reviewer 패스.** `/ai-review academic-paper-revision` 실행(어떤 검토 스킬이든 가능).
   agent가 논문을 읽고 문제마다 `add_comment`를 호출합니다 — **Suggested** 카드(PDF에서는 보라색
   점선 하이라이트)로 나타나며 **reviewer** 또는 **defender** 태그가 붙습니다.
2. **당신이 승인.** Comments 패널에서 동의하는 것을 **Accept**(실행 가능한 *accepted*가 됩니다),
   나머지는 **Reject**, 또는 직접 추가합니다. 손을 떼고 싶다면? **Auto-accept reviewer suggestions
   (copilot)** 를 체크하면 모든 제안이 자동 수락됩니다.
3. **Author가 해결.** `/address-comments` 실행(루프도 가능). author가 수락된 각 코멘트를 그 소스
   위치에서 수정하고 메모와 함께 해결로 표시합니다.

코멘트에는 **답글 스레드**가 있습니다(해결 전에 당신과 agent가 논의 가능). Claude가 하나를 해결하면
그 하이라이트가 **초록색**이 되고(수정 완료, *당신*의 검토 대기) 카드는 *Resolved* 목록으로 이동합니다.
검토는 하나씩 합니다: 수정을 확인한 뒤 **Close**를 누르면 초록 하이라이트가 사라집니다 — 이것이 사람이
확인했다는 단계이므로, 색이 쌓이지 않고 검토하는 대로 정리됩니다. **clear all**로 일괄 닫기도 가능합니다.

### 하이라이트가 텍스트와 살짝 어긋날 수 있는 이유

하이라이트는 pdf.js의 보이지 않는 *텍스트 레이어*(선택에 쓰이는 것과 같은 기하 정보)에서 그려집니다.
이는 캔버스에 글리프가 실제로 그려지는 위치를 줄 단위로 근사한 것이라, 상자가 아주 조금 어긋날 수 있고
확대하면 더 잘 보입니다. 이 작은 오차는 본질적이고 시각적인 문제일 뿐입니다. Claude가 문단을 수정하고
PDF가 재배치된 뒤 생기던 큰 어긋남을 피하려고, TeXChronicle는 **재컴파일할 때마다 하이라이트를 현재
텍스트에 다시 고정**합니다(코멘트 인용의 앞뒤 구절을 매칭). 옛 좌표에 못 박지 않으므로 중간 단어가
바뀌어도 텍스트를 따라갑니다. 문단이 삭제되거나 알아볼 수 없을 만큼 재작성되면 마지막으로 알려진
위치로 되돌아갑니다.

## 비주얼(WYSIWYG) 모드

편집기 바에서 **Code / Visual**을 전환합니다. 비주얼 모드는 문서를 제자리에서 렌더링합니다 —
`\section`/`\textbf`/`\emph`, `$…$` 와 `\begin{equation}` 수식(KaTeX), 목록, `\cite` 칩, 링크 —
그리고 프리앰블은 흐리게 처리합니다. 아무 요소나 클릭하면 원본 LaTeX이 드러나 편집할 수 있습니다.
같은 파일 위에 얹은 장식 레이어라서 소스를 바꾸지 않습니다. **⏎ Wrap**은 긴 줄을 감쌉니다
(줄바꿈 없이 작성된 LaTeX용).

## 파일 트리

**FILES** 패널은 완전한 트리입니다: 폴더를 펼치고, 파일을 클릭해 전환하고, **+ File / + Folder**
또는 각 행의 이름 변경/삭제를 사용합니다. 아래 구분선을 드래그해 크기를 조절합니다.

## 소스 편집기

왼쪽 패널의 **Source** 탭은 프로젝트의 텍스트 파일을 CodeMirror LaTeX 편집기로 나열합니다.
**Ctrl+S**(또는 Save)로 디스크에 쓰면 — watcher가 재컴파일하고 PDF가 갱신됩니다. Typst의 편집기
루프와 똑같습니다. 자신의 편집기를 선호한다면? 어디서 저장하든 같은 루프가 돕니다.

### 대화 안에서 diff 보기

Claude에게 *"show me the diff"*(또는 *"show the diff of the last checkpoint"*)라고 하면 `show_diff`
도구로 **나란히 보는 diff를 이미지로 채팅에 바로** 돌려줍니다. 이 기능이 있는 이유는 Claude Code에
자체 diff 뷰어가 없기 때문입니다 — Claude가 그냥 `git diff`를 돌리면 그 출력을 텍스트로 받아 요약해
버립니다. `show_diff`는 실제 시각적 분할 화면을 줍니다. (*렌더링된 PDF 옆에서* 같은 diff를 보려면
브라우저의 History 패널을, 터미널 분할은 [delta](https://github.com/dandavison/delta)를 설정한
`git diff`를 쓰세요.)

## 논문을 Overleaf로 가져가기

설정에 따라 세 가지 방법이 있습니다. 이 도구는 당신의 자격 증명 없이 Overleaf에 푸시할 수 없으므로,
모두 당신이 주도권을 갖는 방식입니다.

### 1. 깨끗한 zip 업로드(누구나 가능)

**⬆ Export .zip** 클릭. 빌드 입력만 담긴 zip을 받습니다 — `.tex`, `.bib`, `.cls`/`.sty`/`.bst`,
그림 — 빌드 산출물(`.aux`, `.log`, 컴파일된 PDF), `.git/`, `node_modules/`는 제외됩니다.
Overleaf에서 **New Project → Upload Project** 후 zip을 놓으세요.

이것이 확실하고 보편적인 경로입니다 — 계정 연동도, 공개 저장소도 필요 없습니다.

### 2. 원클릭 "Open in Overleaf"(공개 GitHub 저장소)

프로젝트가 git 저장소이고 GitHub `origin`이 **공개**라면 툴바에 **Open in Overleaf ↗** 가 나타납니다.
클릭하면 Overleaf가 저장소의 현재 브랜치 아카이브를 직접 가져옵니다 — 새 프로젝트가 원클릭으로.
공개 저장소에서만 되는 이유는 Overleaf 서버가 인터넷으로 그 아카이브를 가져오기 때문입니다.

### 3. 기존 Overleaf 프로젝트에 동기화(Overleaf Premium — Git bridge)

Overleaf Premium은 각 프로젝트를 git 원격으로 노출합니다. 설정은 한 번, 직접 하세요(토큰은 이 도구가
절대 다루지 않는 자격 증명입니다):

```bash
git remote add overleaf https://git.overleaf.com/<your-project-id>
# git이 비밀번호를 물으면 Overleaf git 토큰을 입력
git push overleaf <branch>
```

그 뒤로 업데이트 게시는 `git push overleaf` 뿐입니다 — Claude에게 실행시켜도 됩니다.

## 패키지 지원 범위

WASM 엔진은 TeX Live의 **부분집합**(basic + recommended + extra)을 담고 있습니다. 흔한 패키지 대부분이
포함됩니다. 자주 빠지는 몇 가지는 자동으로 처리됩니다:
- `algorithm`/`algorithmicx` 계열과 `multirow` — 진짜 `.sty`를 내장(원문 그대로, LPPL)해 주입합니다.
- `bbm` — 작은 **미리보기 대체물**이 `\mathbbm`을 근사합니다(문자는 `\mathbb`, `\mathbbm{1}` 지시
  함수는 간이 이중선 1). 덕분에 논문이 계속 렌더링됩니다.

그 외 부분집합 밖이면서 폰트 기반인 것은 `File '<pkg>.sty' not found`로 실패합니다. 그런 경우 해당
패키지의 `.sty`(와 폰트)를 프로젝트에 넣거나 프리앰블을 조정하세요. 어느 쪽이든 Overleaf에서의 최종
컴파일은 진짜 패키지를 씁니다 — 로컬 미리보기는 근사치입니다.

## 참고

- 컴파일된 PDF는 Overleaf 결과물의 근사(WASM을 통한 현행 TeX Live)이며 비트 단위로 동일함을 보장하지
  않습니다. 대다수 논문에 충분히 정확하지만, 최종 제출처(Overleaf나 투고 시스템)에서 반드시 최종
  컴파일을 하세요.
- 변경 이력은 숨겨진 git ref(`refs/latex-preview/checkpoints`)에 저장되며 당신의 브랜치, `git log`,
  작업 트리를 절대 건드리지 않습니다. 폴더가 git 저장소가 아니면 TeXChronicle 는 그 ref 를 프로젝트
  안 `.latex-preview/history.git` 에 있는 자체 저장소에 보관합니다 — 이력이 폴더와 함께 이동하고
  복사되고 삭제되며, 거기서 `git` 을 실행해도 여전히 저장소가 아니라고 나옵니다.
