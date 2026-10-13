# context

프로젝트의 CLAUDE.md를 **최소한의 루트 + 폴더별 하위 CLAUDE.md** 구조로 만들고, 코드가 바뀌면 다시 맞춥니다.

```
CLAUDE.md                      # 명령, 파일 컨벤션, 하위 문서 목록만
src/lib/api/CLAUDE.md          # 그 폴더의 규칙, 계약, 데이터 흐름
src/app/(dashboard)/CLAUDE.md
```

Claude Code는 루트 CLAUDE.md를 세션마다 읽고, 하위 CLAUDE.md는 그 폴더의 파일을 읽을 때 불러옵니다. 폴더 전용 내용을 하위로 내리면 모든 세션이 읽는 분량이 줄어듭니다.

## 사용법

```
/context:sync              # 저장소 전체
/context:sync src/lib/api  # 이 폴더만
```

"CLAUDE.md 정리해줘", "하위 CLAUDE.md 추가해줘"처럼 말해도 됩니다.

## 하는 일

1. `scan.mjs`로 스택, 기존 CLAUDE.md, 후보 폴더를 조사합니다. 스택은 Tailwind 사용 여부, import 별칭, 테스트 배치, 파일명 관례입니다.
2. 루트 CLAUDE.md에 실제 명령, 조건에 맞는 컨벤션, 하위 문서 목록을 둡니다. 특정 폴더에만 해당하는 내용은 하위로 옮깁니다.
3. 계약·전용 패턴·틀리기 쉬운 전제가 있는 폴더에만 하위 CLAUDE.md를 만듭니다. 단순 컴포넌트 모음에는 만들지 않습니다.
4. 루트 목록과 실제 파일이 일치하는지 다시 확인합니다.

## 기본 컨벤션

JS/TS 프로젝트에 넣는 기본값입니다. 프로젝트가 이미 다른 관례를 일관되게 쓰면 그 관례를 따릅니다.

- 폴더: 공통은 `src/` 직하, 단일 사용처는 사용처 하위 `_components/_lib/_hooks/_stores/_types`
- 파일명: 컴포넌트 PascalCase, 일반·훅 camelCase, 상수 파일·상수명 UPPER_SNAKE_CASE
- import 별칭 `@/*` → `src/*` (tsconfig에 있을 때)
- 테스트는 같은 폴더의 `__tests__/*.test.ts(x)`
- Tailwind 정규형 클래스, 테마 토큰 유틸리티 우선 (**Tailwind를 쓸 때만**)

기본값을 바꾸려면 `skills/sync/references/conventions.md`를 고칩니다.
