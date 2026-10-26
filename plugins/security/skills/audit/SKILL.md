---
name: audit
description: 변경분을 보안 관점으로 감사하고 지적만 보고한다 (코드를 고치지 않는다). 커밋 직전 게이트로 쓰거나, 인증·토큰·권한·외부 입력 처리·네트워크·앱 설정·의존성을 건드린 뒤 사용한다. 사용자가 "보안 점검", "보안 감사", "시크릿 새는 거 없는지 봐줘"라고 할 때도 사용한다.
argument-hint: "[경로 | --base <ref>]"
allowed-tools: Read, Grep, Glob, Bash
---

# 보안 감사

**찾아서 보고할 뿐, 고치지 않는다.** 판단과 수정은 호출한 쪽이 한다. 리뷰 지적과 같은 계약이다.

이 플러그인은 감사를 통과하지 않은 소스 변경의 `git commit`/`git push`를 훅으로 막는다. 통과 기록도 이 스킬이 남기지 않는다. 지적을 처리한 호출 쪽이 `security:sign-off` 스킬로 기록한다.

## 대상 범위

- 기본 대상은 **아직 감사를 통과하지 않은 파일**이다. 이미 통과한 파일까지 다시 보지 않는다. 부른 쪽이 경로를 주면 그 경로만 보고, 주지 않으면 아래 명령으로 대상 목록을 정한다. 처음 감사하면 워킹트리 변경분 전체(untracked 포함)다.

```bash
node "${CLAUDE_SKILL_DIR}/../sign-off/scripts/mark-passed.mjs" --pending
```
- `--base <ref>`를 받으면 `<ref>...HEAD`가 대상이다. 경로를 받으면 그 경로만 본다.
- **A절(저장소에 들어가면 안 되는 것)은 범위와 무관하게 매번 확인한다.** 시크릿은 과거 커밋에 들어가 있어도 지금 사고다.

```bash
git status --short --untracked-files=all
git diff HEAD --stat
```

## 0. 프로젝트 파악

점검하기 전에 이 프로젝트가 무엇인지부터 확인한다. 해당 없는 절은 건너뛰고, 보고서에 "해당 없음"으로 적는다.

- 루트와 변경된 폴더의 `CLAUDE.md`, `AGENTS.md`, `SECURITY.md`. 프로젝트가 정한 보안 규칙(토큰 저장 위치, 인증 흐름, 금지 패턴)이 있으면 그 규칙이 우선한다.
- 매니페스트(`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `app.json`, `AndroidManifest.xml`, `Info.plist` 등)로 플랫폼을 판단한다: 웹 프론트엔드 / 서버·API / 모바일 앱 / CLI·라이브러리.
- 인증·토큰·API 클라이언트·설정 로더가 어디 있는지 `grep`으로 찾아 둔다. 아래 점검은 그 파일들을 기준으로 한다.

## 점검 항목

### A. 저장소에 들어가면 안 되는 것

```bash
git ls-files | grep -iE '(^|/)(\.env($|\.)|.*\.(pem|key|p8|p12|pfx|jks|keystore|mobileprovision)$|id_(rsa|ed25519|ecdsa)$|credentials\.json$|service-account.*\.json$|google-services\.json$|GoogleService-Info\.plist$|\.npmrc$|\.pypirc$|\.netrc$)' | grep -vE '\.(example|sample|template)$'
```

**하나라도 나오면 critical이다.** `.gitignore`에 적혀 있어도 이미 추적 중이면 소용없다. `.npmrc`처럼 시크릿이 없을 수도 있는 파일은 열어서 토큰이 있는지 확인한다.

diff에 실제 값이 박혀 있는지도 본다:

```bash
git diff HEAD | grep -inE '^\+.*(api[_-]?key|secret|password|passwd|token|authorization|bearer|private[_-]?key|client[_-]?secret|access[_-]?key)\s*["'"'"']?\s*[:=]'
git diff HEAD | grep -nE '^\+.*(AKIA[0-9A-Z]{16}|sk_live_|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36}|xox[baprs]-|-----BEGIN [A-Z ]*PRIVATE KEY-----)'
```

상수명·타입 정의·에러 코드·환경 변수 이름은 오탐이다. **값이 실제로 붙어 있는지 파일을 열어 확인한다.** 보고할 때는 값을 마스킹한다 (`sk_live_ab••••`).

### B. 인증·토큰 라이프사이클

- **저장 위치:** 모바일은 Keychain/Keystore 계열(SecureStore 등)이어야 한다. 웹은 가능하면 httpOnly 쿠키를 쓴다. 토큰이 평문 저장소(AsyncStorage, localStorage, MMKV, 파일, 전역 상태 persist)로 옮겨졌으면 지적한다. 프로젝트 규칙과 어긋나면 critical이다.
- **폐기:** 로그아웃과 401/만료 응답에서 토큰이 실제로 지워지는가.
- **전달 경로:** 토큰이 URL 쿼리스트링·로그·에러 메시지·분석 이벤트에 실리는가. 인증 헤더나 쿠키 외의 경로로 나가면 지적한다.
- **서버 검증:** JWT 서명·만료·`alg` 검증, 세션 고정, 비밀번호 해시(평문·약한 해시) 등을 본다.

### C. 릴리스에 실리면 안 되는 개발 경로

- mock 인증·디버그 플래그·테스트 계정이 개발 환경 조건(`__DEV__`, `NODE_ENV`, 빌드 플래그) 없이 켜지는 경로가 있는가. 릴리스에서 누구나 로그인되는 경로면 critical이다.
- mock 모듈이 환경 게이트 없이 import되는 곳이 있는가.
- 하드코딩된 계정, 특정 값이면 인증을 건너뛰는 분기, 디버그 엔드포인트·관리자 라우트가 노출되는가.

### D. 외부 입력 → 위험한 싱크

사용자 입력·요청 파라미터·딥링크·파일 내용이 아래로 검증 없이 들어가는가:

- SQL/NoSQL 쿼리 문자열 조립, 셸 명령 실행 (`exec`, `child_process`, `subprocess(shell=True)`)
- 파일 경로 (path traversal), 서버가 대신 요청하는 URL (SSRF), 리다이렉트 대상 (open redirect)
- HTML 렌더링 (`dangerouslySetInnerHTML`, `v-html`, `innerHTML`, 템플릿 이스케이프 해제) → XSS
- 역직렬화 (`pickle`, `yaml.load`, `eval`, `new Function`)

### E. 권한 검사

- 서버 엔드포인트가 "로그인했는가"만 보고 "이 리소스의 주인인가"는 보지 않는가 (IDOR).
- 권한 판정이 클라이언트에만 있는가. 버튼을 숨기는 것은 권한 검사가 아니다.
- 새로 추가한 라우트·핸들러에 기존 인증 미들웨어가 빠졌는가.

### F. 네트워크·전송

- API·소켓 URL이 `http://`인가 (localhost 제외). TLS 검증을 끄는 옵션이 붙었는가.
- CORS `*`와 credentials를 함께 허용하는가. 쿠키에 `Secure`/`HttpOnly`/`SameSite`가 빠졌는가.
- 개인정보·위치를 보내는 요청이 인증 없이 나가는가.

### G. 로그 유출

로그에 토큰·비밀번호·개인정보(전화번호, 주민번호, 좌표, 이메일)가 실리는가. **모바일은 릴리스 빌드에서도 콘솔 로그가 남는다.**

```bash
git diff HEAD | grep -nE '^\+.*(console\.(log|warn|error|debug|info)|print\(|logger\.|log\.(Print|Info|Debug))'
```

### H. 딥링크·라우팅 (모바일 / SPA)

- 딥링크나 알림 payload로 받은 id를 검증 없이 조회·상태 변경(승인/삭제/결제)에 쓰는가.
- 인증 없이 열리는 화면이 생겼는가. 딥링크가 로그인 게이트를 우회하는 경로가 있는가.

### I. 권한·앱 설정

- 앱 권한(`app.json`, `AndroidManifest.xml`, `Info.plist`의 permissions·background modes·usage description)이 바뀌었으면, **그 권한을 쓰는 코드가 실제로 있는지** 확인한다. 없으면 과다 권한이다. 권한 사용 문구가 실제 용도와 어긋나면 지적한다.
- 웹 보안 헤더(CSP 등)나 프레임워크 보안 설정을 끄거나 약하게 바꿨는가.

### J. 의존성

매니페스트나 lockfile이 바뀌었을 때만 본다. 먼저 스크립트로 사실을 모은다:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/deps.mjs"
```

- 새 패키지와 버전 변경, 새 패키지 중 설치 스크립트(`postinstall` 등)가 있는 것, 유명 패키지와 이름이 한두 글자 다른 것(타이포스쿼팅 의심)을 알려 준다.
- 설치된 취약점 검사 도구(osv-scanner, npm/pnpm/bun audit, pip-audit, cargo audit, govulncheck)를 돌려 심각도별 개수를 낸다. 이 단계만 네트워크를 쓴다(취약점 DB에 패키지 이름·버전을 보낸다). 사용자가 막았거나(`SECURITY_DEPS_SCAN=0`) 오프라인이면 `--offline`을 준다.
- 스크립트 결과는 단서다. 이름이 비슷한 패키지는 레지스트리 이름과 사용처를 확인하고, 설치 스크립트는 lockfile·`node_modules`에서 무엇을 실행하는지 읽는다. 취약점이 이번에 바뀐 패키지에 있으면 지적하고(critical·high는 그대로 심각도로), 원래 있던 패키지에만 있으면 후속 과제로 적는다.
- 도구가 없거나 실패하면 "확인 못 함"으로 보고한다. "취약점 없음"으로 바꾸지 않는다.
- 유지보수가 끊긴 인증·암호 라이브러리도 확인한다.

## 심각도

| | 기준 |
|---|---|
| `critical` | 시크릿이 저장소·번들에 들어감, 릴리스에 mock 인증·백도어가 실림, 토큰이 평문 저장소로 이동, 인증 없이 남의 데이터 접근 |
| `high` | 토큰·개인정보가 실제로 새는 경로, 인젝션, 평문 http 전송, 인증을 우회하는 딥링크·라우트 |
| `medium` | 조건이 겹쳐야 새는 것, 과다 권한, 방어가 한 겹뿐인 지점 |
| `low` | 개선 여지. **실익이 없으면 아예 적지 않는다** |

## 오탐을 만들지 않는 규칙

- **해당 파일·라인을 직접 읽어서 확인한 것만 적는다.** grep 결과를 그대로 옮기지 않는다.
- 지적마다 **"어떻게 악용되는가"를 한 줄로 쓸 수 없으면 적지 않는다.** 공격자가 무엇을 손에 넣는지 쓸 수 없으면 지적이 아니다.
- 이번 변경 범위 밖에 있던 기존 문제는 **"후속 과제"로 따로** 적는다. 커밋을 막는 항목에 섞지 않는다.
- 일반론은 지적이 아니다: "HTTPS를 쓰세요", "입력을 검증하세요" 같은 문장은 적지 않는다.
- **지적 0건도 정상적인 결론이다.** 빈손으로 끝나는 게 두려워 medium을 지어내지 않는다.
- 이 프로젝트에 아직 없는 인프라(별도 백엔드, 로깅 계층, 인증서 피닝 등)를 전제한 지적은 하지 않는다.

## 보고 형식

| 지적 | 심각도 | 위치 | 악용 경로 | 권고 |
|---|---|---|---|---|
| 제목 | critical/high/medium/low | `파일:라인` | 공격자가 무엇을 얻는가 (한 줄) | 무엇을 바꿔야 하는가 |

표 아래에 다음을 적는다:

- **확인했으나 문제 없던 항목:** A~J 중 무엇을 봤고 무엇이 해당 없었는지 한 줄씩. 감사 범위가 드러나야 한다.
- **후속 과제:** 이번 변경 밖의 기존 문제

## 하지 않을 것

- **파일을 수정·생성하지 않는다.** 명백한 구멍을 찾아도 고치지 않고 보고한다.
- 저장소 상태를 바꾸지 않는다. `git add`/`commit`/`stash`/`checkout`은 쓰지 않는다. Bash는 읽기 전용 조회에만 쓴다.
- 네트워크 요청을 보내거나 외부 스캐너를 설치하지 않는다. J절의 `deps.mjs`가 이미 설치된 검사 도구로 취약점 DB를 조회하는 것만 예외다.
- **보고서에 실제 시크릿 값을 그대로 옮겨 적지 않는다.** 앞 4자만 남기고 마스킹한다.
- 취약점을 실제로 익스플로잇해 보지 않는다. 코드를 읽어 경로를 설명하는 데서 멈춘다.
