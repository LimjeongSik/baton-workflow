<p align="center">
  <img src="assets/banner.svg" alt="설계, 구현, 정리, 검증, 반영, 기록으로 이어지는 작업 흐름과 각 단계를 맡는 플러그인" width="100%">
</p>

Claude Code에 매번 같은 지시를 반복하지 않도록, 자주 쓰는 작업 절차를 플러그인으로 묶었습니다. 플러그인마다 작업 흐름의 한 단계를 맡으며, 필요한 것만 골라 설치하면 됩니다.

특정 프로젝트에 묶여 있지 않습니다. 실행할 때마다 그 저장소의 `CLAUDE.md`, `AGENTS.md`, `package.json` 스크립트, 기존 코드를 읽고 검사 명령과 규칙을 정합니다.

## 설치

### 전부 설치

review와 ui가 쓰는 외부 마켓플레이스를 먼저 등록한 뒤, 묶음 플러그인 `all`을 설치합니다.

```
/plugin marketplace add openai/codex-plugin-cc
/plugin marketplace add anthropics/claude-plugins-official
/plugin marketplace add LimjeongSik/baton-workflow
/plugin install all@baton
```

`all`은 자체 기능 없이, 아래 플러그인 10개와 그 의존성(`codex`, `frontend-design`)을 한 번에 설치합니다.

### 골라서 설치

```
/plugin marketplace add LimjeongSik/baton-workflow
/plugin install feature@baton
```

Claude Code 2.1.275 이상에서는 `/plugin install feature --marketplace LimjeongSik/baton-workflow` 한 줄로도 됩니다. review는 `openai/codex-plugin-cc`, ui는 `anthropics/claude-plugins-official` 마켓플레이스가 등록되어 있어야 설치됩니다.

### 설치한 뒤

위의 전부 설치를 마친 뒤, 작업할 프로젝트에서 `/context:sync`를 한 번 실행해 루트 CLAUDE.md에 규칙을 추가해 두면 좋습니다. 그 프로젝트의 실제 명령, 파일 컨벤션, 하위 CLAUDE.md 목록이 정리되고, 이후 Claude는 매 세션 이 규칙대로 작업합니다.

```
/context:sync
```

실행하면 루트 CLAUDE.md에 아래 내용이 들어갑니다. 루트는 60줄 안으로 유지합니다.

- **명령:** `package.json`에 실제로 있는 개발·검사·테스트 스크립트만 적습니다.
- **규칙:** 아래 기본 규칙 중 프로젝트 조건에 맞는 것만 적습니다.
- **하위 CLAUDE.md 목록:** 폴더별 CLAUDE.md의 경로와 주제를 적습니다. 폴더를 새로 만들거나 계약이 바뀌면 그 폴더의 문서와 이 목록을 같은 작업에서 갱신하라는 규칙도 함께 들어갑니다.

| 기본 규칙 | 내용 | 넣는 조건 |
|---|---|---|
| 폴더 | 공통 코드는 `src/` 바로 아래, 한 곳에서만 쓰는 코드는 사용처 아래 `_components/_lib/_hooks/_stores/_types` | JS/TS 프로젝트 |
| 파일명 | 컴포넌트 PascalCase, 일반·훅·상수 파일 camelCase, 상수명만 UPPER_SNAKE_CASE | JS/TS 프로젝트 |
| import 별칭 | tsconfig에 있는 별칭(예: `@/*` → `src/*`)을 씀 | 별칭이 설정되어 있을 때 |
| 테스트 | 같은 폴더의 `__tests__/*.test.ts(x)` | JS/TS 프로젝트 |
| 주석 | 최대 2줄, 함수 본문·객체 리터럴 안에는 쓰지 않음, 코드로 알 수 있는 내용은 쓰지 않음 | 모든 프로젝트 |
| Tailwind | 정규형 클래스, 테마 토큰과 같은 값이면 토큰 유틸리티 사용 | Tailwind를 쓸 때만 |

기존 프로젝트에서 실행해도 기존 코드나 사용자가 쓴 규칙을 바꾸지 않습니다.

- 프로젝트가 다른 관례를 일관되게 쓰고 있으면(예: kebab-case 파일명, `src/` 없는 구조) 기본값 대신 그 관례를 적습니다.
- 기존 CLAUDE.md의 내용은 지우지 않습니다. 기본값과 충돌하는 규칙은 고치지 않고 보고만 합니다.
- 파일 이름 변경, 폴더 이동, 기존 주석 삭제, 커밋은 하지 않습니다.

하위 CLAUDE.md는 다른 폴더가 기대는 계약, 그 폴더 전용 패턴, 틀리기 쉬운 전제(단위, 시간대, 서버·클라이언트 경계)가 있는 폴더에만 만듭니다. 단순 컴포넌트 모음에는 만들지 않습니다. 자세한 내용은 [context](plugins/context)에 있습니다.

### 업데이트

```
/plugin marketplace update baton
```

저장소와 마켓플레이스 이름이 `my-tools-plugins` / `my-tools`에서 `baton-workflow` / `baton`으로 바뀌었습니다. `@my-tools`로 설치했다면 `/plugin marketplace remove my-tools`로 지운 뒤 위의 설치 명령으로 다시 설치하세요.

플러그인 이름도 바뀌었습니다. 예전 이름으로 설치했다면 지우고 새 이름으로 다시 설치하세요. 리뷰 게이트 환경 변수도 `CODEX_TRIAGE_GATE*`에서 `REVIEW_GATE*`로 바뀌었습니다.

| 예전 | 지금 |
|---|---|
| `ui-design`, `feature-flow`, `refactor-sweep`, `security-audit`, `docs-progress` | `ui`, `feature`, `refactor`, `security`, `progress` |
| `codex-triage` (`/codex-triage:review-apply`) | `review` (`/review:codex`) |
| `git-workflow` (`/git-workflow:commit-push`) | `git` (`/git:ship`) |

## 플러그인

| 단계 | 플러그인 | 명령 | 하는 일 |
|---|---|---|---|
| 설계 | [ui](plugins/ui) | `/ui:design` | 화면을 디자인하고, 목업 이미지로 승인받은 뒤 구현 |
| 구현 | [feature](plugins/feature) | `/feature:build` | 기능 구현과 테스트 작성을 서로 다른 에이전트에게 맡김 |
| 정리 | [refactor](plugins/refactor) | `/refactor:sweep` | 리팩터링할 곳을 찾아 동작을 바꾸지 않고 고침 |
| 검증 | [test](plugins/test) | `/test:write` | 변경된 코드의 테스트를 폴더별 `__tests__/`에 작성하고 실행 |
| 검증 | [security](plugins/security) | `/security:audit` | 실제로 악용될 수 있는 보안 문제만 찾고, 감사 전에는 커밋·푸시를 막음 |
| 검증 | [review](plugins/review) | `/review:codex` | Codex 리뷰를 받아 검증된 지적만 반영하고, 리뷰 전에는 커밋·푸시를 막음 |
| 반영 | [git](plugins/git) | `/git:ship` | 테스트·감사·리뷰를 거쳐 변경을 나눠 커밋하고 푸시 |
| 기록 | [progress](plugins/progress) | `/progress:update` | 다음 세션이 읽을 진행 문서를 짧게 유지 |
| 기록 | [context](plugins/context) | `/context:sync` | 루트 CLAUDE.md는 짧게, 폴더별 규칙은 하위 CLAUDE.md로 나눠 관리 |
| 기록 | [prefs](plugins/prefs) | `/prefs:learn` | 사용자가 고르거나 고쳐 준 방식을 기록해 다음 작업부터 그 방식으로 진행 |

슬래시 명령 대신 "기능 만들어줘", "테스트 작성해줘", "커밋하고 푸시해줘"처럼 말해도 됩니다.

### 코드를 올리는 흐름

`/git:ship` 한 번으로 아래 순서를 끝까지 진행합니다. 앞 단계를 통과하지 못하면 멈춥니다.

```
사전 검사(lint·타입) → 테스트 → 보안 감사 → 코드 리뷰 → 커밋 → 푸시
```

- **테스트:** 러너(vitest, jest 등)가 없으면 설치할지 묻고, 동의하면 설치한 뒤 진행합니다. 테스트가 소스 버그를 찾으면 소스를 고치지 않고 멈춰서 보고합니다.
- **보안 감사와 리뷰:** 통과하지 않은 소스 변경은 커밋도 푸시도 할 수 없습니다. Claude가 실행하는 `git commit`/`git push`를 두 플러그인의 훅이 각각 검사합니다. 통과는 파일 내용 단위로 기록되므로, 리뷰를 반영하느라 바뀐 파일은 그 파일만 다시 감사받습니다. 문서와 에셋은 검사하지 않습니다.
- 시크릿 파일이 이미 추적 중이거나, 심각한 지적이 남았거나, force push가 필요하면 멈추고 묻습니다.

게이트는 프로젝트의 `.claude/settings.json`의 `env`로 끌 수 있습니다: `SECURITY_GATE=0`, `REVIEW_GATE=0` (커밋·푸시만 따로 끄는 방법은 [review](plugins/review), [sign-off 스킬](plugins/security/skills/sign-off/SKILL.md) 참고).

### 플러그인별 특징

- **ui:** [frontend-design](https://github.com/anthropics/claude-plugins-official) 스킬 위에서 동작합니다. 레퍼런스에서 가져올 것과 베끼지 않을 것을 나누고, 대시보드·모바일 앱·랜딩 페이지마다 기준을 달리합니다. 근거 없는 다크 테마, 보라 그라데이션, 똑같은 카드 나열은 팔레트 검사와 점검표로 걸러냅니다.
- **feature:** 구현 에이전트는 테스트를 쓰지 않고, 테스트 에이전트는 소스를 고치지 않습니다. 자기 코드에 맞춰 쓴 테스트는 버그를 잡지 못하기 때문입니다.
- **refactor:** 정찰 에이전트가 후보를 내면 메인 에이전트가 코드를 열어 확인하고, 쓰는 곳이 하나뿐인 추상화 같은 과한 제안은 기각합니다. 테스트가 깨지면 고치지 않고 되돌립니다.
- **test:** 기존 테스트의 패턴을 따라 동작을 테스트합니다. 스냅샷 테스트는 쓰지 않고, 실패한 테스트를 `skip`으로 돌리지 않습니다.
- **security:** "어떻게 악용되는가"를 한 줄로 쓸 수 없는 지적은 보고하지 않습니다. 지적이 없으면 없다고 보고합니다.
- **review:** 지적마다 코드를 확인해서 반영할 것과 기각할 것을 나누고, 근거를 표로 남깁니다.
- **progress:** `docs/PROGRESS.md`에 날짜별로 그날의 최종 상태만 남기고 최근 7일치만 둡니다. 세션을 시작할 때 문서보다 새 커밋이 있으면 알려줍니다.
- **context:** 루트 CLAUDE.md에는 명령, 파일 컨벤션, 하위 문서 목록만 둡니다. 컨벤션은 프로젝트의 기존 관례를 우선하고, Tailwind 규칙은 Tailwind를 쓸 때만 넣습니다. 한 번 실행해 두면 이후로는 CLAUDE.md에 적힌 규칙대로 Claude가 문서를 맞춥니다.
- **prefs:** 목업에서 고른 방향, "에러는 인라인으로" 같은 수정 요청, 거절한 리팩터링 후보처럼 사용자가 실제로 보여준 방식만 `docs/PREFERENCES.md`에 지시문으로 적습니다. 한 번 고른 것은 `[관찰]`, "앞으로는"이라고 했거나 두 번 이상 고른 것은 `[확정]`으로 두고, `[확정]`은 다음부터 묻지 않고 따릅니다. 세션을 시작할 때 문서 내용이 자동으로 들어가고, 80줄 안으로 유지합니다. 모든 코드가 지켜야 하는 규칙(파일명, 폴더 구조)은 여기가 아니라 CLAUDE.md에 둡니다.

### 함께 설치하면

플러그인은 다른 플러그인이 **설치되어 있을 때만** 씁니다. 하나만 설치해도 동작하고, 빠진 단계는 건너뛴 뒤 보고에 적습니다.

- git은 test, security, review가 있으면 그 단계를 커밋 조건으로 씁니다.
- feature와 refactor는 화면이 바뀌는 작업을 ui로 먼저 디자인하고, 끝나면 progress로 기록합니다. 새 도메인 폴더를 만들었으면 context로 하위 CLAUDE.md를 추가합니다.
- ui, feature, refactor, test, git은 시작할 때 `docs/PREFERENCES.md`가 있으면 읽고 따르며, 작업 중 사용자가 고르거나 고친 것이 있으면 끝날 때 prefs로 기록합니다.

## 필요한 것

- Claude Code, Node.js (훅과 스크립트 실행)
- review: [Codex CLI](https://github.com/openai/codex) (`npm install -g @openai/codex`)
- ui: 목업 렌더링용 Playwright 또는 Chrome 계열 브라우저. 없으면 처음 실행할 때 Playwright 브라우저를 내려받습니다

## 개발

```
plugins/<이름>/
├── .claude-plugin/plugin.json
├── skills/<스킬>/SKILL.md
├── agents/<에이전트>.md
└── hooks/hooks.json
```

1. 위 구조로 플러그인을 만들고 `.claude-plugin/marketplace.json`에 등록합니다.
2. `claude plugin validate .`와 `claude plugin validate plugins/<이름>`으로 검증합니다.
3. `node --test`로 테스트를 돌립니다.
4. `claude --plugin-dir plugins/<이름>`으로 실제 프로젝트에서 써 봅니다.

`tests/`에는 훅과 스크립트의 테스트가 있습니다. 임시 git 저장소를 만들어 게이트가 막아야 할 때 막고 허용해야 할 때 허용하는지, 스캔·감지 스크립트가 맞는 결과를 내는지 확인합니다. review와 security는 따로 설치되는 플러그인이라 게이트 코드를 각자 복사해 두었고, 두 복사본이 어긋나면 테스트가 실패합니다. 게이트 코드는 두 플러그인을 함께 고치세요.

## 라이선스

MIT
