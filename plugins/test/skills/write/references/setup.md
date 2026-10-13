# 테스트 러너 설치

**사용자가 설치에 동의한 뒤에만** 이 문서대로 설치한다. `detect.mjs`의 `recommended`와 `project`를 기준으로 고른다. 패키지 추가 명령은 `project.addDevCommand`를 쓴다 (lockfile로 정해진 패키지 매니저).

설치한 뒤에는 반드시 아래 "설치 확인"까지 마친다.

## vitest (JS/TS 기본)

```bash
<addDevCommand> vitest
# React: <addDevCommand> @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom @vitejs/plugin-react
# Vue:   <addDevCommand> @testing-library/vue jsdom @vitejs/plugin-vue
```

이미 `vite.config.*`가 있으면 거기에 `test` 블록을 추가한다. 없으면 `vitest.config.ts`를 만든다:

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react"; // React일 때만
import path from "node:path";

export default defineConfig({
    plugins: [react()],
    resolve: {
        // project.aliases를 그대로 옮긴다. 예: "@/*" → ["./src/*"]
        alias: { "@": path.resolve(import.meta.dirname, "src") },
    },
    test: {
        environment: "jsdom", // recommended.environment
        setupFiles: ["./vitest.setup.ts"], // jest-dom을 쓸 때만
    },
});
```

```ts
// vitest.setup.ts (jest-dom을 쓸 때만)
import "@testing-library/jest-dom/vitest";
```

- 기본 `include`가 `**/*.{test,spec}.?(c|m)[jt]s?(x)`라서 `__tests__/*.test.ts(x)`는 설정 없이 실행된다.
- `package.json`의 `scripts.test`는 `"vitest run"`으로 둔다. `vitest`만 쓰면 watch 모드로 멈춰 있는다.
- TypeScript에서 `describe`·`expect`를 import 없이 쓰려면 `globals: true`와 `tsconfig`의 `types: ["vitest/globals"]`가 필요하다. 기본은 명시적 import(`import { describe, expect, test } from "vitest"`)다.

## jest (React Native / Expo)

Expo:

```bash
npx expo install jest-expo jest @testing-library/react-native @types/jest
```

React Native(Expo 아님): RN 템플릿은 jest가 이미 들어 있는 경우가 많다. 없으면:

```bash
<addDevCommand> jest @testing-library/react-native @types/jest
```

`package.json`:

```json
{
  "scripts": { "test": "jest" },
  "jest": { "preset": "jest-expo" }
}
```

- preset은 `recommended.preset`을 쓴다 (`jest-expo` 또는 `react-native`).
- 경로 별칭은 `moduleNameMapper`에 옮긴다: `{ "^@/(.*)$": "<rootDir>/src/$1" }`.
- jest의 기본 `testMatch`는 `**/__tests__/**/*.[jt]s?(x)`와 `**/?(*.)+(spec|test).[jt]s?(x)`라서 `__tests__`가 그대로 실행된다.

## pytest (Python)

```bash
uv add --dev pytest          # uv 프로젝트 (uv.lock)
poetry add --group dev pytest # poetry 프로젝트 (poetry.lock)
pip install pytest            # 그 밖: 개발 의존성 파일(requirements-dev.txt 등)이 있으면 거기에도 추가
```

Python은 `__tests__` 관례가 없다. 기존 배치가 없으면 최상위 `tests/test_<모듈>.py`에 둔다.

## Go / Rust

내장 러너(`go test ./...`, `cargo test`)를 쓴다. 설치할 것이 없다.

## 설치 확인

1. 테스트 하나 없이 러너만 실행해 설정 오류가 없는지 본다: `<runScript> test` (vitest는 테스트가 0개면 실패 코드를 내므로 `--passWithNoTests`를 붙여 확인한다).
2. 타입 검사가 있으면 함께 돌려 설정 파일에 타입 오류가 없는지 본다.
3. 바뀐 파일(`package.json`, lockfile, 설정 파일)을 보고에 적는다. lockfile 변경도 커밋 대상이다.
