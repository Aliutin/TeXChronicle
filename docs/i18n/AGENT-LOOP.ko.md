# 에이전트 루프 — 트리거로서의 코멘트

[English](../AGENT-LOOP.md) · [简体中文](AGENT-LOOP.zh-CN.md) · [日本語](AGENT-LOOP.ja.md) · **한국어** · [Español](AGENT-LOOP.es.md) · [Français](AGENT-LOOP.fr.md) · [Deutsch](AGENT-LOOP.de.md) · [Português](AGENT-LOOP.pt.md)

작업 공간은 **PDF 위의 코멘트**를 **Claude를 위한 작업**으로 바꿉니다. 당신은 문서를 가리키고, Claude는 소스를 다룹니다. 이 문서는 그 과정을 루프로 돌려 당신이 남긴 코멘트를 Claude가 계속 처리하도록 만드는 방법을 설명합니다 — 논문이 스스로 굴러가고 당신은 히스토리를 지켜보는 상태로 가는 첫걸음입니다.

## 한 번의 흐름(수동)

1. 작업 공간에서 렌더링된 PDF 위의 텍스트를 선택하고 코멘트를 남깁니다
   (예: *"이 문단을 압축해줘"*, *"이 주장에는 인용이 필요해"*).
2. Claude Code에서 **"address my comments"** 라고 말합니다.
3. Claude가 `check_comments`를 호출해 수락된 각 코멘트를 **위치가 특정된 작업 항목**으로 받습니다:

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

4. 각 항목마다 Claude는 해당 `파일:줄`에서 소스를 열어 수정하고 `resolve_comment(id, note)`를
   호출합니다. 저장하면 재컴파일과 git 체크포인트가 자동으로 실행되므로 PDF가 갱신되고
   변경 사항은 **History**에서 diff로 확인할 수 있습니다.
5. 각 카드는 Claude의 메모와 함께 **해결됨 ✓** 으로 바뀝니다. 다시 말할 필요가 없습니다.

## 루프로 돌리기(방치 운영)

Claude Code의 `/loop`로 코멘트 수신함을 계속 감시하게 합니다. 논문 프로젝트에서:

```
/loop 60s Address my PDF comments: call check_comments; for each accepted item, edit the
source at its location per the instruction and call resolve_comment with a one-line note.
If there are no accepted comments, do nothing this pass.
```

- 약 60초마다 Claude가 새 코멘트를 확인하고 처리합니다. 코멘트를 남기고 자리를 비웠다 돌아오면
  카드는 해결되어 있고 체크포인트 diff도 남아 있습니다.
- `check_comments`가 "No accepted comments"를 반환하는 건 깔끔한 no-op이라 빈 회차는 비용이 적습니다.
- 언제든 루프를 멈출 수 있고, 그동안 한 일은 전부 git 히스토리에 있습니다.

## 왜 '지켜보기'만 하면 되고 '돌보기'는 필요 없나

- **추적 가능** — 모든 회차가 History에서 열 수 있는 체크포인트와 카드의 해결 메모를 남기므로,
  *무엇이* 바뀌었고 *왜* 바뀌었는지 언제나 확인할 수 있습니다.
- **되돌릴 수 있음** — 체크포인트는 숨겨진 git ref에 있고, 당신의 `git log`와 작업 트리는 전혀
  건드리지 않습니다. 어떤 변경이든 평소 방식대로 되돌리면 됩니다.
- **범위가 한정됨** — Claude는 코멘트가 가리키는 곳만 수정합니다. 수신함이 비어 있으면 수정도 없습니다.

## reviewer → 사람의 승인 → resolver 워크플로

코멘트 수신함에는 세 가지 상태가 있고, 이것이 전체 검토 사이클을 이룹니다:

`suggested`(제안) → (사람이 수락) → `accepted`(수락됨) → (author 루프) → `resolved`(해결됨)

1. **Reviewer가 코멘트를 게시.** 검토 스킬로 논문에 표시를 하게 합니다 — 문제마다
   `add_comment(quote, comment)`를 호출하고, 이는 **제안**으로 안착합니다(PDF의 보라색 점선
   하이라이트, *Suggested* 섹션의 카드):

   ```
   Review my paper using my installed academic-review skill.
   For each issue, call add_comment
   with the exact quoted passage and your comment. Don't edit the source yet.
   ```

2. **사람이 검토를 승인.** *Suggested* 섹션에서 동의하는 것을 **Accept**(실행 가능한 `accepted`가
   됩니다), 나머지는 **Reject**, 또는 직접 수정/추가합니다. `check_comments`는 의도적으로
   `suggested` 항목을 무시합니다 — author는 당신이 수락하지 않은 제안에는 절대 손대지 않습니다.

   - 손을 떼고 싶다면? Comments 패널 상단의 **Auto-accept reviewer suggestions (copilot)** 를 켜면
     제안이 도착하는 즉시 모두 수락됩니다. (완전 무인 agent는 `add_comment(..., accepted: true)`로
     바로 실행 가능한 코멘트를 게시할 수도 있습니다.)

3. **Author 루프가 해결.** 위의 루프를 돌리면 `accepted` 코멘트를 가져와, 특정된 각 `파일:줄`에서
   수정하고, 재컴파일하고, 메모와 함께 해결 처리합니다.

4. **모든 것이 기록됨.** 수락·수정·해결마다 체크포인트와 메모가 남으므로, reviewer→author 한
   회차 전체를 **History**에서 추적할 수 있습니다.

## Ultra-agents ⚡

> [!CAUTION]
> TeXChronicle에서 가장 강력한 명령이자 감독이 가장 적은 명령입니다 — 설계상 회차마다 당신의 승인을
> 받지 않습니다. 큰 `depth`로 실행하기 전에 이 섹션을 끝까지 읽으세요.

`/ultra-agents [skill] [depth]`는 2단계의 사람 승인 관문을 **완전히 제거합니다** — reviewer가 모든
코멘트를 `add_comment(..., accepted: true)`로 올리므로 제기되는 즉시 실행 가능해지고, author가
바로 뒤이어 해결합니다. 그리고 반복합니다: **방금 수정된** 논문을 다시 검토하고, 다시 고치기를
최대 `depth` 회차(기본 **2**)까지. 어떤 회차에서 새로운 지적이 하나도 없으면 그 즉시 멈춥니다 —
이미 수렴한 논문이 남은 횟수를 낭비하지 않습니다.

초안을 밀어붙이는 가장 빠른 방법이자 가장 감독이 없는 방법입니다 — 회차별 확인 지점은 *당신*을
위한 게 아니라 도구를 위한 것뿐입니다. `depth`를 5보다 크게 요청하면 먼저 멈춰 확인을 받습니다.
가볍게 신청하기엔 상당한 양의 무인 편집이기 때문입니다. 어떤 depth를 고르든 실행은 이렇습니다:

```
/ultra-agents academic-paper-revision 3
```

끝나면(depth를 채웠든 일찍 수렴했든) `list_checkpoints`를 호출해 **회차별로 묶은 요약**을 줍니다 —
무엇이 제기됐고, 무엇이 바뀌었고, 각 회차에 해당하는 체크포인트 sha는 무엇인지. 덕분에
`/show_diff <sha>`로 어떤 회차든 바로 갈 수 있고 History를 뒤질 필요가 없습니다. 안전망은 여기
다른 기능들과 동일합니다: 각 회차는 여전히 평범한 체크포인트이며, History 탭에서 검토하고
되돌릴 수 있습니다(회차 전체든 파일 단위든). 이는 **피해는 복구 가능하지만 시간은 그렇지 않다**는
뜻입니다 — 어떤 회차가 잘못 굴러갔는지 지켜보는 건 요약을 읽는 당신뿐입니다. 그러니 나중에
직접 검토할 각오가 된 초안에 쓰세요. 손대지 않고 그대로 내보낼 버전에 쓸 것이 아닙니다.

이것은 여전히 'reviewer 하나 + author 하나, 가운데 사람'인 구조입니다. 여러 Claude Code 세션이
이미 같은 프로젝트에서 동시에 작업해도 코멘트나 체크포인트가 손상되지 않습니다(모든 변경이
크로스 프로세스 락 아래에서 실행됩니다 — [`ROADMAP.ko.md`](ROADMAP.ko.md) 참고). 하지만 여전히
번갈아 작업하는 것이지 진짜 병렬 편집은 아닙니다. 진정한 동시 multi-agent(reviewer / author /
defender가 각자의 git 브랜치에서 조율하며 진행)는 다음 마일스톤입니다 —
[`ROADMAP.ko.md`](ROADMAP.ko.md) 참고.
