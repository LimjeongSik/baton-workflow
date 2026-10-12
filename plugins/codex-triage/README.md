# codex-triage

커밋 단위로 [Codex](https://github.com/openai/codex-plugin-cc) 리뷰를 받고, Claude가 각 지적을 코드로 직접 검증해 **타당한 것만 반영**하는 워크플로우입니다.

## 설치

이 플러그인은 OpenAI의 `codex` 플러그인을 사용합니다. 아래처럼 codex 마켓플레이스를 먼저 등록하면 의존성이 자동으로 설치됩니다.

```
/plugin marketplace add openai/codex-plugin-cc
/plugin marketplace add LimjeongSik/my-tools-plugins
/plugin install codex-triage@my-tools
```

codex CLI도 필요합니다:

```bash
npm install -g @openai/codex
```

설치 후 Claude Code에서 `/codex:setup`으로 로그인을 마칩니다.

## 사용법

작업을 커밋한 뒤:

```
/codex-triage:review-apply
```

"codex 리뷰 받아줘"처럼 자연어로 요청해도 됩니다. 인자 예시:

| 인자 | 의미 |
|---|---|
| (없음) | `adversarial-review`, 마지막 리뷰 지점..HEAD |
| `review` | 일반 리뷰 모드 |
| `--base main` | 리뷰 범위의 시작점 지정 (처음 도입할 때 권장) |
| `"인증 경로"` | 마지막 인자로 주면 포커스 텍스트로 쓰임 |

흐름: 품질 게이트 → codex 리뷰 → 지적마다 코드 검증 → 채택한 것만 최소 수정·커밋 → 재검증 → (critical/high를 반영했다면) 재리뷰 1회 → 채택/기각 표로 보고.

## 리뷰 기준점과 Stop 게이트

- 리뷰가 끝나면 `refs/codex-review/last` ref를 HEAD로 옮깁니다. 다음 리뷰는 그 지점부터 시작합니다.
- **이 ref가 있는 저장소에서만** Stop 훅이 동작합니다. 리뷰되지 않은 커밋이 남은 채로 Claude가 작업을 끝내려 하면 리뷰를 요구합니다.
- 게이트 끄기: `CODEX_TRIAGE_GATE=0` 환경 변수를 설정하거나 `git update-ref -d refs/codex-review/last`로 ref를 지웁니다.

## 리뷰 로그

리뷰 원문은 `<저장소 루트>/.claude/review-logs/<sha>.md`에 저장됩니다. `.gitignore`에 추가하세요:

```
.claude/review-logs/
```

`CODEX_TRIAGE_LOG_DIR`로 저장 위치를 바꿀 수 있습니다.

## 권한 프롬프트 줄이기 (선택)

프로젝트의 `.claude/settings.json`에 추가합니다:

```json
{
  "permissions": {
    "allow": ["Bash(git update-ref refs/codex-review/last HEAD)"]
  }
}
```
