# review

커밋하기 전에 [Codex](https://github.com/openai/codex-plugin-cc) 리뷰를 받고, Claude가 각 지적을 코드로 직접 검증해 **타당한 것만 반영**합니다. 리뷰를 통과하지 않은 소스 변경은 커밋도 푸시도 할 수 없습니다.

## 설치

이 플러그인은 OpenAI의 `codex` 플러그인을 사용합니다. codex 마켓플레이스를 먼저 등록하면 의존성이 자동으로 설치됩니다.

```
/plugin marketplace add openai/codex-plugin-cc
/plugin marketplace add LimjeongSik/baton-workflow
/plugin install review@baton
```

codex CLI도 필요합니다:

```bash
npm install -g @openai/codex
```

설치한 뒤 Claude Code에서 `/codex:setup`으로 로그인합니다.

## 사용법

기능 구현이나 버그 수정을 마치면, 커밋하기 전에:

```
/review:codex
```

"codex 리뷰 받아줘"처럼 말해도 됩니다.

| 인자 | 의미 |
|---|---|
| (없음) | `adversarial-review`. 커밋되지 않은 변경이 있으면 작업 트리를, 없으면 마지막 리뷰 지점 이후 커밋을 리뷰 |
| `review` | 일반 리뷰 모드 |
| `--base origin/main` | 커밋 범위를 직접 지정 (처음 도입할 때 권장) |
| `"인증 경로"` | 마지막 인자로 주면 포커스 텍스트로 쓰임 |

흐름: 품질 게이트 → codex 리뷰 → 지적마다 코드 검증 → 채택한 것만 최소 수정 → 재검증 → (critical/high를 반영했다면) 재리뷰 1회 → 리뷰 통과 기록 → 채택/기각 표로 보고

## 리뷰 게이트

Claude가 실행하는 `git commit`과 `git push`를 PreToolUse 훅이 검사합니다.

| 명령 | 통과 조건 |
|---|---|
| `git commit` | 이번 커밋에 담기는 소스 변경(staged 파일, `git add`로 지정한 경로, `commit -a`, commit에 준 경로)이 리뷰를 통과한 내용 |
| `git push` | 원격에 없는 커밋들이 바꾼 소스 파일의 HEAD 내용이 리뷰를 통과한 내용 |

- 리뷰 통과는 **파일 내용(blob 해시)** 으로 `<git-dir>/codex-review/reviewed.json`에 기록됩니다. 저장소에는 커밋되지 않습니다.
- 리뷰 뒤에 파일이 바뀌면 다시 리뷰해야 합니다. 리뷰를 마친 변경은 여러 커밋으로 나눠도 됩니다.
- 문서, 이미지·폰트 같은 에셋, lockfile, `.claude/` 설정은 검사하지 않습니다.
- merge·cherry-pick·revert·rebase 중의 커밋과 원격 브랜치 삭제는 검사하지 않습니다.
- codex CLI가 없으면 막지 않고 사용자에게 확인을 받습니다.
- 리뷰가 필요 없는 변경이라고 사용자가 동의하면, 스킬이 이유와 함께 "리뷰 생략"으로 기록합니다.

Stop 훅도 함께 동작합니다. 이 저장소에서 한 번이라도 리뷰를 기록한 뒤에는, 소스를 고친 턴이 끝날 때 리뷰를 통과하지 않은 변경이 남아 있으면 리뷰를 요청합니다.

### 게이트 설정

프로젝트의 `.claude/settings.json`에서 끌 수 있습니다:

```json
{
  "env": {
    "REVIEW_GATE_COMMIT": "0"
  }
}
```

| 변수 | 효과 |
|---|---|
| `REVIEW_GATE=0` | 모든 게이트 끄기 |
| `REVIEW_GATE_COMMIT=0` | 커밋 게이트만 끄기. 커밋을 먼저 하고 나중에 리뷰하는 흐름. 푸시는 여전히 막힘 |
| `REVIEW_GATE_PUSH=0` | 푸시 게이트만 끄기 |
| `REVIEW_GATE_STOP=0` | 종료 시 리뷰 요청 끄기 |

게이트는 Claude가 실행하는 명령만 검사합니다. 터미널에서 직접 실행하는 git 명령은 막지 않습니다.

## 리뷰 로그

리뷰 원문은 `<저장소 루트>/.claude/review-logs/<시각>-<sha>.md`에 저장됩니다. `.gitignore`에 추가하세요:

```
.claude/review-logs/
```

`REVIEW_LOG_DIR`로 저장 위치를 바꿀 수 있습니다.
