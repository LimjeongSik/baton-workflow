<p align="center">
  <img src="assets/banner.svg" alt="준비, 설계, 구현, 정리, 검증, 반영, 기록으로 이어지는 작업 흐름과 각 단계를 맡는 플러그인" width="100%">
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

`all`은 자체 기능 없이, 아래 플러그인 12개와 그 의존성(`codex`, `frontend-design`)을 한 번에 설치합니다.

### 골라서 설치

```
/plugin marketplace add LimjeongSik/baton-workflow
/plugin install feature@baton
```

Claude Code 2.1.275 이상에서는 `/plugin install feature --marketplace LimjeongSik/baton-workflow` 한 줄로도 됩니다. review는 `openai/codex-plugin-cc`, ui는 `anthropics/claude-plugins-official` 마켓플레이스가 등록되어 있어야 설치됩니다.

### 설치한 뒤

작업할 프로젝트에서 아래 명령을 한 번씩 실행해 두면, 이후 세션은 그 결과를 기준으로 작업합니다.

| 명령 | 하는 일 |
|---|---|
| `/context:sync` | 루트 CLAUDE.md에 그 프로젝트의 실제 명령, 파일 컨벤션, 하위 CLAUDE.md 목록을 정리 |
| `/biome:setup` | Biome을 설치하고 프로젝트 종류(Next, React Native, Expo 등)에 맞춘 `biome.json`과 `.vscode` 설정을 만듦 |

<details>
<summary><code>/context:sync</code>가 CLAUDE.md에 넣는 내용</summary>

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
| React 훅 | 파생 값은 `useState`에 두지 않고 렌더 중 계산, `useEffect`는 외부 시스템 동기화에만, 의존성·정리 함수 빠뜨리지 않음 | React · React Native |
| 웹 | 렌더링(서버·클라이언트 경계, 리렌더 범위), 네트워크(요청 위치·캐시), 상태(단일 출처, URL 상태) | 웹 프로젝트 |
| 앱 | 화면 스택(파라미터 계약, 포커스·이탈 처리), 목록 가상화, 화면·전역 상태 구분, 오프라인·재시도 | React Native · Expo |

기존 프로젝트에서 실행해도 기존 코드나 사용자가 쓴 규칙을 바꾸지 않습니다.

- 프로젝트가 다른 관례를 일관되게 쓰고 있으면(예: kebab-case 파일명, `src/` 없는 구조) 기본값 대신 그 관례를 적습니다.
- 기존 CLAUDE.md의 내용은 지우지 않습니다. 기본값과 충돌하는 규칙은 고치지 않고 보고만 합니다.
- 파일 이름 변경, 폴더 이동, 기존 주석 삭제, 커밋은 하지 않습니다.

하위 CLAUDE.md는 다른 폴더가 기대는 계약, 그 폴더 전용 패턴, 틀리기 쉬운 전제(단위, 시간대, 서버·클라이언트 경계)가 있는 폴더에만 만듭니다. 단순 컴포넌트 모음에는 만들지 않습니다. 웹 프로젝트는 렌더링·네트워크·상태 관리, 앱 프로젝트는 화면 스택·렌더링·상태 관리·네트워크를 중심으로 씁니다. 자세한 내용은 [context](plugins/context)에 있습니다.

</details>

## 업데이트

> [!TIP]
> **이번 업데이트: 검증은 필요한 만큼만, 막을 곳은 확실하게**
>
> - **위험도에 맞춘 검증:** 작고 민감하지 않은 변경은 Codex 리뷰를 건너뛰고, 보안은 시크릿 자동 스캔으로 끝냅니다. 인증·API·설정·의존성·위험한 코드가 보이면 감사 에이전트와 `adversarial-review`를 씁니다.
> - **리뷰 비용 절감:** Codex에는 아직 리뷰하지 않은 줄만 보냅니다. `git:ship`은 같은 내용으로 통과한 검사·테스트를 다시 돌리지 않고, 실패한 단계부터 이어서 합니다.
> - **게이트 강화:** 판단할 수 없으면 통과시키지 않고, `sh -c`·`eval`·git alias 안의 커밋도 검사합니다. 의존성이 바뀌면 취약점·가짜 패키지를 확인합니다.
> - **사용량 실측:** `/baton:usage`로 토큰·서브에이전트·codex 시간을 봅니다.
>
> ```
> /baton:update
> ```

### 한 번에 업데이트

`/baton:update` 하나로 마켓플레이스 목록을 갱신하고, 설치된 baton 플러그인을 범위(user·project·local)와 프로젝트에 상관없이 모두 업데이트합니다. 끝나면 `/reload-plugins`를 실행하거나 재시작합니다.

- baton 플러그인이 없으면 먼저 `/plugin install baton@baton`으로 설치합니다. `all`을 0.4.0 이상으로 업데이트해도 함께 설치됩니다.
- `/baton:update --dry-run`은 실행할 명령만 보여 줍니다.
- 터미널에서는 `node ~/.claude/plugins/marketplaces/baton/plugins/baton/scripts/update.mjs`로 같은 일을 합니다.
- 설치했던 프로젝트 폴더를 옮겼거나 지웠으면 그 설치는 건너뛰고 목록으로 알려 줍니다.
- 플러그인을 user 범위로 설치해 두면 프로젝트마다 따로 업데이트할 일이 없습니다.

<details>
<summary>직접 업데이트하려면</summary>

**1. 마켓플레이스 목록 갱신**: 목록만 새로 받습니다. 이미 설치한 플러그인의 버전은 바뀌지 않습니다.

```
/plugin marketplace update baton
```

**2. 플러그인 업데이트**: `/plugin`에서 플러그인을 골라 업데이트하거나, 터미널에서 실행합니다. user 범위가 아닌 곳(project, local)에 설치했다면 `-s`로 범위를 지정해야 합니다.

```
claude plugin update review@baton
claude plugin update feature@baton -s project
```

**3. 적용**: Claude Code를 재시작하거나 `/reload-plugins`를 실행해야 새 버전이 적용됩니다.

</details>

### 이번에 바뀐 플러그인

| 플러그인 | 버전 | 바뀐 점 |
|---|---|---|
| [git](plugins/git) | 0.4.0 | 시작할 때 변경의 위험도를 판정해 테스트·감사·리뷰의 강도를 정합니다. 검사·테스트 결과를 작업 트리 내용에 묶어 남기므로, 같은 내용이면 통과한 단계는 건너뛰고 실패했으면 그 단계부터 이어서 합니다 |
| [review](plugins/review) | 0.3.0 | Codex에는 아직 리뷰하지 않은 줄만 보내고(이미 리뷰한 파일·줄과 공백만 바뀐 파일은 빠짐), 리뷰할 게 없으면 Codex를 부르지 않습니다. 위험도로 모드를 고르고, 작고 민감하지 않은 변경은 자동 생략으로 기록합니다. 지적마다 코드 근거·재현 경로·심각도를 확인합니다 |
| [security](plugins/security) | 0.3.0 | 민감하지 않은 변경은 시크릿 자동 스캔으로 기록합니다. 의존성이 바뀌면 새 패키지, 설치 스크립트, 유명 패키지와 이름이 비슷한 패키지를 짚고 설치된 취약점 검사 도구를 돌립니다. lockfile만 바뀌어도 민감한 변경으로 봅니다 |
| review · security 공통 | | 게이트가 판단할 수 없으면 통과시키지 않습니다. `sh -c`·`eval`·백틱·git alias 안의 커밋도 검사하고, 한 명령에 커밋이 여러 번 있을 때 새 파일이 검사에서 빠지던 문제를 고쳤습니다. 처음 통과를 기록할 때 Claude Code의 커밋만 검사하는 git 훅 백스톱을 설치합니다 |
| [feature](plugins/feature) | 0.1.5 | 작업 규모만큼만 서브에이전트를 띄웁니다. 테스트 에이전트는 구현 보고가 아니라 계획 단계의 완료 조건에서 기대값을 가져옵니다 |
| [prefs](plugins/prefs) | 0.4.2 | 묻지 않고 학습하는 방식은 그대로입니다. 키·토큰·자격 증명 URL·사설 IP·홈 경로·이메일·전화번호 같은 값은 학습 파일에 남기지 않고(세션을 시작할 때도 파일에서 지움), 프로젝트 규칙·기존 항목과 충돌하는 지시문은 올리지 않습니다 |
| [progress](plugins/progress) | 0.2.0 | 문서를 쓰기 전에 커밋·미커밋 변경·`git:ship` 검사 기록을 모아, 커밋되지 않은 작업을 완료로 쓰거나 지난 검사 결과를 지금 결과로 쓰지 않습니다. 마지막 `git:ship`이 실패했으면 다음 세션에 알립니다 |
| [baton](plugins/baton) | 0.2.0 | `/baton:usage`로 세션의 토큰·시간·호출 수를 실측합니다 |

<details>
<summary>이전 변경</summary>

| 플러그인 | 버전 | 바뀐 점 |
|---|---|---|
| [prefs](plugins/prefs) | 0.4.1 | 학습 결과를 전역(`~/.claude`)이 아니라 Claude를 실행한 폴더의 `learn/`에 둡니다. `learn/`이 없으면 세션을 시작할 때 만들고 `.gitignore`에 넣습니다. 0.3.0이 `~/.claude/prefs/`에 남긴 신호는 처음 학습할 때 그 프로젝트 줄만 옮깁니다 |
| ui, refactor, test, biome | 0.1.6 · 0.1.4 · 0.1.4 · 0.1.2 | 프로젝트의 `learn/learned.md`에서 학습한 프로필을 따릅니다 |
| [context](plugins/context) | 0.1.2 | 웹은 렌더링·네트워크·상태 관리, 앱은 화면 스택·렌더링·상태 관리·네트워크 위주로 CLAUDE.md를 씁니다. React · React Native에는 `useState`·`useEffect` 훅 규칙을 넣습니다 |
| [ui](plugins/ui) | 0.1.4 | 텍스트 스타일마다 자간·행간을 정하고, 어색한 한국어 카피를 걸러냅니다 |
| [all](plugins/all) | 0.4.0 | baton 플러그인을 함께 설치합니다 |
| [biome](plugins/biome) · [baton](plugins/baton) | 0.1.0 | 새 플러그인. 업데이트만으로는 설치되지 않으므로 `/plugin install <이름>@baton`으로 따로 설치합니다 |

</details>

<details>
<summary>예전 이름(<code>my-tools</code>, <code>codex-triage</code> 등)으로 설치했다면</summary>

저장소와 마켓플레이스 이름이 `my-tools-plugins` / `my-tools`에서 `baton-workflow` / `baton`으로 바뀌었습니다. `@my-tools`로 설치했다면 `/plugin marketplace remove my-tools`로 지운 뒤 위의 설치 명령으로 다시 설치하세요.

플러그인 이름도 바뀌었습니다. 예전 이름으로 설치했다면 지우고 새 이름으로 다시 설치하세요. 리뷰 게이트 환경 변수도 `CODEX_TRIAGE_GATE*`에서 `REVIEW_GATE*`로 바뀌었습니다.

| 예전 | 지금 |
|---|---|
| `ui-design`, `feature-flow`, `refactor-sweep`, `security-audit`, `docs-progress` | `ui`, `feature`, `refactor`, `security`, `progress` |
| `codex-triage` (`/codex-triage:review-apply`) | `review` (`/review:codex`) |
| `git-workflow` (`/git-workflow:commit-push`) | `git` (`/git:ship`) |

</details>

## 플러그인

| 단계 | 플러그인 | 명령 | 하는 일 |
|---|---|---|---|
| 준비 | [biome](plugins/biome) | `/biome:setup` | Biome을 설치하고 프로젝트 종류에 맞춘 `biome.json`과 `.vscode` 설정을 만듦 |
| 설계 | [ui](plugins/ui) | `/ui:design` | 화면을 디자인하고, 목업 이미지로 승인받은 뒤 구현 |
| 구현 | [feature](plugins/feature) | `/feature:build` | 기능 구현과 테스트 작성을 서로 다른 에이전트에게 맡김 |
| 정리 | [refactor](plugins/refactor) | `/refactor:sweep` | 리팩터링할 곳을 찾아 동작을 바꾸지 않고 고침 |
| 검증 | [test](plugins/test) | `/test:write` | 변경된 코드의 테스트를 폴더별 `__tests__/`에 작성하고 실행 |
| 검증 | [security](plugins/security) | `/security:audit` | 실제로 악용될 수 있는 보안 문제만 찾고, 감사 전에는 커밋·푸시를 막음 |
| 검증 | [review](plugins/review) | `/review:codex` | 아직 리뷰하지 않은 변경을 Codex로 리뷰해 검증된 지적만 반영하고, 리뷰 전에는 커밋·푸시를 막음 |
| 반영 | [git](plugins/git) | `/git:ship` | 위험도에 맞춰 테스트·감사·리뷰를 거쳐 변경을 나눠 커밋하고 푸시 |
| 기록 | [progress](plugins/progress) | `/progress:update` | 다음 세션이 읽을 진행 문서를 실제 커밋·검사 결과에 맞춰 짧게 유지 |
| 기록 | [context](plugins/context) | `/context:sync` | 루트 CLAUDE.md는 짧게, 폴더별 규칙은 하위 CLAUDE.md로 나눠 관리 |
| 기록 | [prefs](plugins/prefs) | 자동 | 사용자의 요청과 행동에서 작업 방식을 스스로 학습해 실행한 폴더의 `learn/`에 쌓고, 그 프로젝트의 다음 작업부터 적용 |
| 관리 | [baton](plugins/baton) | `/baton:update` · `/baton:usage` | 설치된 baton 플러그인을 한 번에 업데이트하고, 세션의 토큰·시간·호출 수를 실측 |

슬래시 명령 대신 "기능 만들어줘", "테스트 작성해줘", "커밋하고 푸시해줘", "토큰 얼마나 썼어"처럼 말해도 됩니다.

### 코드를 올리는 흐름

`/git:ship` 한 번으로 아래 순서를 끝까지 진행합니다. 앞 단계를 통과하지 못하면 멈춥니다.

```
계획(위험도 판정) → 사전 검사(lint·타입) → 테스트 → 보안 감사 → 코드 리뷰 → 커밋 → 푸시
```

**위험도에 맞춘 검증.** 경로(인증·API·서버 등), 설정·의존성·배포 파일, 추가된 줄의 패턴(시크릿, 토큰 저장, 셸 실행, `innerHTML`, SQL 등), 규모(기본 소스 20줄·3개 파일)로 판정합니다.

| 위험도 | 예 | 테스트 | 보안 감사 | 리뷰 |
|---|---|---|---|---|
| trivial | 상수 하나, 문구 수정 | 기존 테스트만 실행 | 시크릿 자동 스캔 | 자동 생략 |
| standard | 일반 기능 코드 | 변경 파일 테스트 작성 | 시크릿 자동 스캔 | Codex `review` |
| sensitive | 인증, API 라우트, 의존성, `innerHTML` | 변경 파일 테스트 작성 | 감사 에이전트 | Codex `adversarial-review` |

- 자동 스캔·자동 생략은 스크립트가 위험도를 다시 판정해 맞을 때만 기록되므로, Claude가 민감한 변경을 건너뛸 수 없습니다.
- 판정은 추정이라서, Claude가 diff를 읽다가 더 위험하다고 보면 한 단계 올립니다. 낮추지는 않습니다.
- 프로젝트마다 `BATON_MODE`로 조절합니다([설정](#설정)). 어떤 모드도 민감한 변경을 낮추지 않습니다.

**다시 실행할 때.** 검사·테스트 결과를 작업 트리 내용에 묶어 `<git-dir>/baton/`에 남깁니다. 같은 내용이면 통과한 단계는 건너뛰고, 실패했으면 그 단계의 원인부터 이어서 합니다.

**단계별로.**

- **테스트:** 러너(vitest, jest 등)가 없으면 설치할지 묻고, 동의하면 설치한 뒤 진행합니다. 테스트가 소스 버그를 찾으면 소스를 고치지 않고 멈춰서 보고합니다.
- **보안 감사와 리뷰:** 통과하지 않은 소스 변경은 커밋도 푸시도 할 수 없습니다. Claude가 실행하는 `git commit`/`git push`를 두 플러그인의 훅이 각각 검사합니다. 통과는 파일 내용 단위로 기록되므로 리뷰를 반영하느라 바뀐 파일만 다시 감사받고, Codex에는 아직 리뷰하지 않은 줄만 보냅니다. 공백만 바뀐 파일은 이전 통과를 이어받습니다(Python·YAML 제외). 문서와 에셋은 검사하지 않습니다.
- **게이트가 판단할 수 없을 때:** 훅 입력을 해석하지 못하면 막고, git이 실패하거나 해석할 수 없는 형태(`xargs git commit` 등)면 확인을 받습니다. 처음 통과를 기록할 때 `.git/hooks`에 pre-commit·pre-push 백스톱을 설치해, 스크립트나 alias로 실행된 커밋도 잡습니다. 백스톱은 Claude Code가 실행한 커밋만 검사하고, 기존 훅이나 husky 같은 `core.hooksPath`가 있으면 설치하지 않습니다. Claude Code 안에서 `! git commit`으로 직접 커밋할 때 막히면 `--no-verify`를 붙입니다.
- **멈추고 묻는 경우:** 시크릿 파일이 이미 추적 중일 때, 심각한 지적이 남았을 때, force push가 필요할 때.
- **보고:** 커밋 해시, 검사·테스트 결과, 채택·기각한 지적과 함께, `baton`이 있으면 사용량 한 줄(토큰, 서브에이전트 비중, codex 횟수·시간, 게이트에 막힌 횟수)을 붙입니다.

감사 통과는 "이번 변경에서 악용 경로를 찾지 못했다"는 기록이지 보안 보증이 아닙니다. 팀 저장소라면 CI의 검사·의존성 감사와 함께 쓰세요.

### 플러그인별 특징

- **ui:** [frontend-design](https://github.com/anthropics/claude-plugins-official) 스킬 위에서 동작합니다. 레퍼런스에서 가져올 것과 베끼지 않을 것을 나누고, 대시보드·모바일 앱·랜딩 페이지마다 기준을 달리합니다. 근거 없는 다크 테마, 보라 그라데이션, 똑같은 카드 나열은 팔레트 검사와 점검표로 걸러냅니다. 텍스트 스타일마다 자간·행간을 정하고, 화면의 한국어가 번역투 없이 자연스러운지 확인합니다.
- **feature:** 구현한 쪽은 테스트를 쓰지 않고, 테스트 에이전트는 소스를 고치지 않습니다. 자기 코드에 맞춰 쓴 테스트는 버그를 잡지 못하기 때문입니다. 테스트의 기대값은 계획 단계에서 쓴 완료 조건에서 가져옵니다. 서브에이전트는 작업 규모만큼만 띄웁니다. 작은 작업은 메인이 직접 구현하고 테스트 에이전트만 띄웁니다.
- **refactor:** 정찰 에이전트가 후보를 내면 메인 에이전트가 코드를 열어 확인하고, 쓰는 곳이 하나뿐인 추상화 같은 과한 제안은 기각합니다. 테스트가 깨지면 고치지 않고 되돌립니다.
- **test:** 기존 테스트의 패턴을 따라 동작을 테스트합니다. 스냅샷 테스트는 쓰지 않고, 실패한 테스트를 `skip`으로 돌리지 않습니다.
- **security:** "어떻게 악용되는가"를 한 줄로 쓸 수 없는 지적은 보고하지 않습니다. 지적이 없으면 없다고 보고합니다. 의존성이 바뀌면 새 패키지, 설치 스크립트, 이름이 비슷한 가짜 패키지를 짚고, 설치된 취약점 검사 도구(osv-scanner, npm/pnpm/bun audit, pip-audit, cargo audit, govulncheck)를 돌립니다. 도구가 없으면 "확인 못 함"으로 보고하고 "취약점 없음"으로 바꾸지 않습니다.
- **review:** 지적마다 코드 근거·재현 경로·심각도를 확인해서 반영할 것과 기각할 것을 나누고, 근거를 표로 남깁니다. 재리뷰는 반영한 수정분만 봅니다.
- **progress:** `docs/PROGRESS.md`에 날짜별로 그날의 최종 상태만 남기고 최근 7일치만 둡니다. 쓰기 전에 커밋·미커밋 변경·검사 기록을 모아, 확인된 것만 적습니다. 세션을 시작할 때 문서보다 새 커밋이 있거나 마지막 `git:ship`이 실패했으면 알려줍니다.
- **context:** 루트 CLAUDE.md에는 명령, 파일 컨벤션, 하위 문서 목록만 둡니다. 컨벤션은 프로젝트의 기존 관례를 우선하고, Tailwind 규칙은 Tailwind를 쓸 때만, React 훅 규칙(`useState`·`useEffect` 남발 금지)은 React · React Native일 때만 넣습니다. 웹과 앱은 각각 다른 초점으로 씁니다. 한 번 실행해 두면 이후로는 CLAUDE.md에 적힌 규칙대로 Claude가 문서를 맞춥니다.
- **biome:** 같은 기본 컨벤션(들여쓰기 4칸, 줄 길이 100, import 그룹 정렬)을 쓰되, Next·React Native·Expo 등 프로젝트 종류에 맞춰 제외 폴더, 린트 domain, DOM 전용 규칙, import 첫 그룹을 바꿉니다. 기존 `biome.json`, ESLint·Prettier 설정, `lint` 스크립트는 묻지 않고 바꾸지 않습니다.
- **baton:** `/baton:usage`는 transcript에 기록된 실측값으로 모델별·서브에이전트별 토큰, 도구·스킬 호출 수, codex 리뷰 횟수와 시간, 게이트에 막힌 횟수를 보여 줍니다. 금액으로 바꾸지는 않습니다.
- **prefs:** 사용자가 시키지 않아도 Claude가 작업 방식을 스스로 학습합니다. "기억해 둘까요?", "기록할까요?"처럼 묻지 않고, 남길지와 지시문으로 올릴지를 Claude가 판단 근거로 정합니다.
  - **신호 모으기:** 작업을 마칠 때 메인 에이전트가 신호(고친 것, 고른 것, 거절한 것, "앞으로는" 같은 지시, 반복되는 반응, 직접 고친 코드, 학습한 대로 한 결과를 받아들였는지)를 모아 학습 담당 서브에이전트에게 넘깁니다.
  - **학습:** 작업 방식·디자인 스타일·선호 기술·코드 패턴·글쓰기·피하는 것 중 하나에 들고 그 프로젝트의 다른 작업에서도 쓰일 신호만 `learn/observed.md`에 쌓고, 서로 다른 작업에서 같은 방향이 확인된 것만 일반화해 `learn/learned.md`에 지시문으로 올립니다. 한 번 나온 선택은 `observed.md`에만 남습니다.
  - **확정과 추정:** "앞으로는"이라고 했거나 직접 두 번 이상 고른 것은 `[확정]`(묻지 않고 따름), 행동에서 판단한 것은 `[추정]`(다른 근거가 없을 때만 따르고 보고에 밝힘)입니다. 학습한 대로 한 결과를 사용자가 고치면 그 항목을 고치거나 지웁니다. 프로젝트 CLAUDE.md나 기존 항목과 부딪히는 지시문은 올리지 않습니다.
  - **민감한 정보:** 일하는 방식만 남기고 값은 남기지 않습니다. 키·토큰·자격 증명 URL·사설 IP·홈 경로·이메일·전화번호·카드 번호는 기록할 때 거르고, 세션을 시작할 때도 `learn/` 파일에서 지웁니다. 실명, 내부 호스트, 고객사 이름, 붙여 넣은 로그도 남기지 않습니다.
  - **위치:** `learn/`은 Claude를 실행한 폴더에 있고, 없으면 세션을 시작할 때 빈 양식으로 만듭니다(git 저장소 안일 때만). 모노레포에서 `frontend/`에서 실행하면 `frontend/learn/`을 쓰고 최상위나 다른 폴더의 `learn/`은 참고하지 않습니다. 하위 폴더(`src/` 등)가 아니라 프로젝트 폴더에서 실행하세요.
  - **git:** `learn/`을 새로 만들 때 그 폴더의 `.gitignore`에 `/learn/`을 넣어 커밋되지 않게 합니다. 팀과 나누려면 그 줄을 지우고 커밋하세요. 이미 있던 `learn/`은 건드리지 않습니다.

### 함께 설치하면

플러그인은 다른 플러그인이 **설치되어 있을 때만** 씁니다. 하나만 설치해도 동작하고, 빠진 단계는 건너뛴 뒤 보고에 적습니다.

- git은 test, security, review가 있으면 그 단계를 커밋 조건으로 쓰고, baton이 있으면 보고에 사용량을 붙입니다.
- feature와 refactor는 화면이 바뀌는 작업을 ui로 먼저 디자인하고, 끝나면 progress로 기록합니다. 새 도메인 폴더를 만들었으면 context로 하위 CLAUDE.md를 추가합니다.
- progress는 git이 남긴 검사·테스트 기록을 7절(마지막 검증)에 씁니다.
- ui, feature, refactor, test, git, biome은 prefs가 학습한 프로필에서 작업에 맞는 절을 따르고, 작업 중 드러난 신호를 끝날 때 prefs에 넘깁니다.

## 설정

프로젝트의 `.claude/settings.json`에 `env`로 넣습니다. 모두 넣지 않아도 됩니다.

```json
{
  "env": {
    "BATON_MODE": "standard"
  }
}
```

| 변수 | 값 | 하는 일 |
|---|---|---|
| `BATON_MODE` | `fast` · `standard` · `strict` | 위험도 판정 조절. `fast`는 민감하지 않으면 trivial로, `standard`는 trivial도 리뷰, `strict`는 모두 sensitive로 봄. 기본은 판정 그대로 |
| `REVIEW_GATE` · `SECURITY_GATE` | `0` | 리뷰·보안 게이트 끄기. `_COMMIT=0`·`_PUSH=0`으로 커밋·푸시만 따로 끔. `REVIEW_GATE_STOP=0`은 종료 시 리뷰 요청만 끔 |
| `BATON_BACKSTOP` | `0` | `.git/hooks` 백스톱을 설치하지 않음 |
| `SECURITY_DEPS_SCAN` | `0` | 의존성 취약점 DB 조회를 하지 않음 (취약점 DB에 패키지 이름·버전을 보내는 단계) |
| `DOCS_PROGRESS_PATH` | 경로 | 진행 문서 위치 (기본 `docs/PROGRESS.md`) |

## 필요한 것

- Claude Code, Node.js (훅과 스크립트 실행)
- review: [Codex CLI](https://github.com/openai/codex) (`npm install -g @openai/codex`)
- ui: 목업 렌더링용 Playwright 또는 Chrome 계열 브라우저. 없으면 처음 실행할 때 Playwright 브라우저를 내려받습니다
- 선택: [osv-scanner](https://github.com/google/osv-scanner). 있으면 security가 모든 생태계의 의존성 취약점을 한 번에 봅니다. 없으면 설치된 npm/pnpm/bun audit, pip-audit 등을 씁니다

## 개발

```
plugins/<이름>/
├── .claude-plugin/plugin.json
├── skills/<스킬>/SKILL.md
├── agents/<에이전트>.md
├── hooks/hooks.json
└── lib/                 # shared/에서 복사한 공통 코드 (review·security·git·progress)
shared/gate-core.mjs     # 게이트 공통 코드의 정본
scripts/sync-shared.mjs  # 정본을 각 플러그인 lib/로 복사
```

1. 위 구조로 플러그인을 만들고 `.claude-plugin/marketplace.json`에 등록합니다.
2. `claude plugin validate .`와 `claude plugin validate plugins/<이름>`으로 검증합니다.
3. `node --test tests/*.test.mjs`로 테스트를 돌립니다.
4. `claude --plugin-dir plugins/<이름>`으로 실제 프로젝트에서 써 봅니다.

**공통 코드.** 변경 수집, 명령 해석, 위험도 판정, 리뷰 델타, git 훅 백스톱은 `shared/gate-core.mjs`에 있습니다. 플러그인은 따로 설치되어 서로의 파일을 import할 수 없으므로 각 플러그인의 `lib/`에 복사본을 둡니다. 정본을 고친 뒤 `node scripts/sync-shared.mjs`로 복사하세요. 복사본이 어긋나면 테스트가 실패합니다.

**테스트.**

| 파일 | 확인하는 것 |
|---|---|
| `gates.test.mjs`, `gate-core.test.mjs` | 임시 git 저장소에서 게이트가 막아야 할 때 막고 허용해야 할 때 허용하는지, 위험도 판정·자동 기록, 리뷰 델타, 백스톱, ship 단계 기록, 의존성 점검, 기록 형식 호환 |
| `hooks-integration.test.mjs` | 모든 플러그인의 `hooks.json`을 함께 설치한 상태로 실행해 출력 형식, 결정 합치기(deny > ask > allow), 실행 순서에 따른 차이, 훅이 저장소를 건드리지 않는지 |
| `prefs-hook`, `progress`, `usage`, `context-scan`, `test-detect`, `biome-setup` | 각 플러그인의 훅과 스크립트 |
| `e2e/claude.e2e.mjs` | 실제 Claude Code(`claude -p`)에서 플러그인 로딩, 게이트 차단·허용, SessionStart 훅. API 비용이 들어 따로 실행합니다: `BATON_E2E=1 node --test tests/e2e/*.e2e.mjs` (기본 모델 haiku, 세션당 상한 `BATON_E2E_BUDGET` 기본 0.5달러) |

**기록 형식 호환.** 통과 기록(`<git-dir>/codex-review/`, `security-audit/`)에는 형식 버전이 있습니다. 버전이 없는 옛 기록은 그대로 읽고, 모르는 필드는 저장할 때 남기며, 더 새 버전이 쓴 기록은 덮어쓰지 않습니다. 플러그인을 이전 버전으로 되돌려도 기록을 잃지 않습니다.

## 라이선스

MIT
