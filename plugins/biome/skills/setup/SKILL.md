---
name: setup
description: 프로젝트에 Biome(포맷터·린터)을 설치하고, 프로젝트 종류(Next, React, React Native, Expo, Vue 등)에 맞춘 biome.json과 저장 시 포맷·import 정리·type import 자동 추가를 위한 .vscode/settings.json, .vscode/extensions.json을 만든다. 사용자가 "biome 설치해줘", "biome 세팅", "포맷터·린터 설정해줘", "컨벤션 맞추게 biome 깔아줘"라고 할 때, 또는 다른 작업 중 Biome이 없어 포맷·린트 기준이 없을 때 사용한다.
argument-hint: "[--force]"
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion
---

# Biome 설치 & 설정

baton 플러그인은 컨벤션 검사에 Biome을 쓴다. 이 스킬은 Biome을 설치하고, 프로젝트 종류에 맞게 고친 기본 설정을 쓴다. **기존 설정 파일, 다른 도구(ESLint, Prettier), 기존 스크립트는 사용자 동의 없이 지우거나 덮어쓰지 않는다.**

## 1. 감지

작업할 프로젝트 폴더(가장 가까운 `package.json`이 있는 곳)에서 실행한다.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/setup.mjs"
```

출력되는 JSON의 내용:
- `project.kind`: `next` / `react` / `react-native` / `expo` / `vue` / `svelte` / `solid` / `node`
- `project`: TypeScript·Tailwind 사용 여부, 경로 별칭(`alias`, 예: `@`), 패키지 매니저, `installCommand`, `execCommand`, `runScript`
- `biome`: 설치된 버전(`installed`), package.json에 적힌 버전, 기존 설정 파일(`existingConfig`)
- `others`: ESLint·Prettier 설정 파일
- `plan`: 파일별로 할 일(`create` / `merge` / `skip` / `manual`), 추가할 스크립트와 충돌하는 스크립트
- `preview`: 쓸 biome.json과 .vscode/settings.json 내용

`package.json`이 없으면 JS/TS 프로젝트가 아니므로 멈추고 보고한다.

`docs/PREFERENCES.md`(사용자 선호 문서)가 있으면 공통 절과 포맷·린트 관련 항목을 읽는다. `[확정]` 항목은 묻지 않고 따르고(예: 들여쓰기 2칸), `[관찰]` 항목은 선택지를 고를 때 먼저 고려하고, `[추정]` 항목은 다른 근거가 없을 때만 따르고 보고에 밝힌다. 기본값과 다르면 4단계에서 쓴 biome.json을 그 값으로 고친다.

## 2. 프로젝트 종류별로 달라지는 것

스크립트가 `kind`에 따라 아래를 자동으로 바꾼다. 기본값(들여쓰기 4칸, 줄 길이 100, 큰따옴표, 세미콜론, JSON 끝 쉼표 없음)은 종류와 상관없이 같다.

| 항목 | Next | React(Vite 등) | React Native / Expo | 그 외 |
|---|---|---|---|---|
| 제외 폴더 | `.next`, `out`, `next-env.d.ts` | `dist` | `android`, `ios` (+ Expo: `.expo`, `web-build`, `dist`, `expo-env.d.ts`) | `dist` |
| linter domains | `next`, `react` | `react` | `react` | `vue`·`solid` (해당할 때) |
| React 규칙 (`useHookAtTopLevel`, `useExhaustiveDependencies`, `noArrayIndexKey`) | 넣음 | 넣음 | 넣음 | 안 넣음 |
| DOM 규칙 (`noDangerouslySetInnerHtml`, a11y 완화) | 넣음 | 넣음 | 안 넣음 (DOM이 없음) | 안 넣음 |
| import 첫 그룹 | `react`, `react-dom` → `next` | `react`, `react-dom` | `react`, `react-native` (+ Expo: `expo`, `expo-*`, `@expo/*`) | 없음 |

공통으로 조건에 따라 바뀌는 것:
- **TypeScript일 때만** `useImportType`(separatedType), type import를 맨 뒤 그룹으로 모으기, VS Code의 `preferTypeOnlyAutoImports`, `[typescript]`·`[typescriptreact]` 포맷터 설정을 넣는다.
- **Tailwind(또는 NativeWind)를 쓸 때만** `css.parser.tailwindDirectives`를 켠다.
- **tsconfig에 와일드카드 별칭이 있을 때만** `<별칭>/components/**` → `<별칭>/constants·hooks·lib·types/**` → `<별칭>/**` 그룹을 넣는다. 별칭 이름(`@`, `~` 등)은 tsconfig 값을 따른다.
- `.git`이 상위에 있을 때만 `vcs`(gitignore 사용)를 켠다. `package-lock.json`이 있으면 제외한다.

특정 파일만 규칙을 끄는 `overrides`, 특정 폴더만 빼는 `includes` 항목은 프로젝트마다 다르므로 만들지 않는다. 5단계 검사에서 필요해 보이면 제안만 한다.

## 3. 묻고 설치한다

**설치하거나 파일을 쓰기 전에 반드시 AskUserQuestion으로 묻는다.** 질문 하나에 감지한 종류와 할 일을 모두 담는다.

- 질문: "`<kind>` 프로젝트로 감지했습니다. Biome을 설치하고 설정 파일을 만들까요?"
- 선택지: 설치 후 설정 (Recommended) / 설정 파일만 만들기 (이미 설치되어 있을 때) / 하지 않음
- 설명에 적을 것: 설치할 패키지(`@biomejs/biome`, 버전 고정 `-E`), 만들거나 고칠 파일(`plan`의 각 항목과 action), 추가할 스크립트

아래 경우는 같은 질문에 이어서(별도 질문으로) 묻는다:
- **`biome.existingConfig`가 있으면**: 그대로 둠 (Recommended) / 덮어쓰기(`--force`) / 차이만 보여주기. 덮어쓰면 기존 파일의 `overrides`와 프로젝트 전용 `includes`가 사라진다는 점을 설명에 적는다.
- **`plan.vscodeSettings.changed`가 비어 있지 않으면**: 그 키들의 기존 값이 바뀐다는 점(예: Prettier → Biome 포맷터)을 적고 진행할지 묻는다.
- **`plan.scripts.conflicts`가 있으면**: 기존 스크립트(예: `"lint": "next lint"`)를 그대로 둠 (Recommended) / `biome check`로 바꿈 / 뒤에 `&& biome check`를 붙임.

ESLint·Prettier가 있어도 지우지 않는다. 보고에 남겨 두고, Prettier 설정이 있으면 VS Code에서 Biome이 우선된다는 점만 알린다.

거절하면 아무것도 바꾸지 않고 끝낸다.

동의하면 `biome.installed`가 없을 때 `project.installCommand`로 설치한다. 실패하면 멈추고 출력을 그대로 보고한다.

## 4. 파일 쓰기

```bash
node "${CLAUDE_SKILL_DIR}/scripts/setup.mjs" --write          # 기존 biome.json은 건너뜀
node "${CLAUDE_SKILL_DIR}/scripts/setup.mjs" --write --force  # 사용자가 덮어쓰기를 골랐을 때만
```

- `biome.json`: `$schema`는 설치된 Biome 버전에 맞춘다.
- `.vscode/settings.json`: 없으면 만들고, 있으면 기존 키를 유지한 채 Biome 관련 키만 덮어쓴다. 주석이 있는 파일도 읽지만 다시 쓸 때 주석은 남지 않는다. 주석이 있었다면 보고에 적는다.
- `.vscode/extensions.json`: 추천 확장에 `biomejs.biome`을 넣는다. 확장이 설치되어 있어야 저장 시 포맷과 import 정리가 동작한다.
- `package.json`: `lint`(`biome check`), `format`(`biome check --write`)이 없을 때만 추가한다. 3단계에서 기존 스크립트를 바꾸기로 했으면 Edit으로 직접 고친다.

`skipped`에 파싱 실패가 있으면 그 파일은 직접 Edit으로 합친다. `preview.vscodeSettings`의 키를 기존 파일에 넣는다.

## 5. 확인

```bash
<execCommand> check --max-diagnostics=20
```

- 설정 오류(알 수 없는 키, 스키마 불일치)가 나오면 biome.json을 고치고 다시 돌린다. 설정 오류는 이 스킬이 책임진다.
- 코드의 포맷·린트 위반은 고치지 않는다. 위반 수(오류·경고)와 많이 나온 규칙 상위 몇 개만 보고한다.
- 위반이 있으면 마지막에 AskUserQuestion으로 묻는다: 지금 고치지 않음 (Recommended) / `<runScript> format`으로 전체 적용. 전체 적용은 많은 파일을 바꾸므로 기능 변경과 섞이지 않게 별도 커밋을 권한다고 설명에 적는다. 적용한 뒤에도 남는 오류는 자동 수정이 안 되는 것이므로 목록만 보고한다.

## 6. 보고

```
| 파일 | 결과 |
|---|---|
| biome.json | 생성 (next, Biome 2.x.x) |
| .vscode/settings.json | 병합 (변경된 키: [typescript]) |
| .vscode/extensions.json | 생성 |
| package.json | 스크립트 추가: lint, format |
```

표 아래에 다음을 적는다:
- 감지한 프로젝트 종류와 그에 따라 기본 설정에서 바꾼 부분
- 설치한 패키지와 버전
- 확인 명령과 결과를 **실제 출력 그대로** (요약이 길면 마지막 요약 줄)
- 남겨 둔 것: ESLint·Prettier 설정, 그대로 둔 스크립트, 건너뛴 파일과 이유
- VS Code에서 Biome 확장을 설치하라는 안내 (추천 확장 팝업이 뜬다)

**선호 기록:** 사용자가 기본값을 바꾸게 했거나(들여쓰기, 따옴표, 줄 길이, 규칙 수준, import 그룹), 선택지 중 하나를 골랐거나, "앞으로는" 같은 지시를 했고 `prefs:learn` 스킬을 쓸 수 있으면 그 내용을 요약해 넘겨 실행한다. 이 프로젝트에만 해당하는 내용(특정 파일 override)은 넘기지 않는다.

## 하지 않을 것

- 사용자 동의 없이 설치하거나 설정 파일 쓰기
- 기존 biome.json을 `--force` 선택 없이 덮어쓰기
- ESLint·Prettier 설정이나 패키지 지우기
- 동의 없이 `biome check --write`로 코드 전체 바꾸기
- 커밋·푸시하기
