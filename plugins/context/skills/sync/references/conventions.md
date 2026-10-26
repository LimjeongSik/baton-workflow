# 기본 규칙

루트 CLAUDE.md의 "규칙" 절에 넣는 기본값이다. **프로젝트가 이미 다른 관례를 일관되게 쓰고 있으면 그 관례를 적는다.** 기본값으로 기존 코드를 갈아엎지 않는다. 판단 근거는 `scan.mjs`의 `stack` 결과다.

각 규칙에는 적용 조건이 있다. 조건에 맞지 않는 규칙은 넣지 않는다.

## 공통 (JS/TS 프로젝트)

조건: `package.json`이 있다.

```markdown
- 폴더: 공통은 `src/` 직하, 단일 사용처는 사용처 하위 `_components/_lib/_hooks/_stores/_types`.
- 파일명: 컴포넌트 PascalCase, 일반·훅·상수 파일 camelCase. 상수명만 UPPER_SNAKE_CASE (예: `future.ts` 안에 `export const FUTURE_SKEW_MS = 5_000`).
- import 별칭 `@/*` → `src/*`.
- 테스트는 같은 폴더의 `__tests__/*.test.ts(x)`.
```

조정 규칙:

| 규칙 | 넣지 않거나 바꾸는 경우 |
|---|---|
| 폴더 | `stack.srcDir`가 false면 `src/` 대신 실제 소스 루트(`app/`, `lib/` 등)로 바꿔 적는다. 사용처 하위 폴더 중 `stores`·`types`처럼 프로젝트에 해당 개념이 없는 것은 뺀다. |
| 파일명 | `naming.kebabFiles`가 `componentsPascal`보다 확연히 많으면 프로젝트가 kebab-case를 쓰는 것이다. 그 관례를 적는다. Next.js의 `page.tsx`·`layout.tsx`·`route.ts` 같은 예약 파일명은 예외라고 한 줄 덧붙인다. |
| import 별칭 | `stack.aliases`에 있는 별칭을 그대로 적는다. 별칭이 없으면 규칙을 넣지 않는다. 사용자가 원하면 tsconfig에 추가할 것을 제안만 한다. |
| 테스트 | `tests.total`이 0이면 기본값을 적는다. 테스트가 있는데 `colocated`나 `topLevel`이 `inTestsFolder`보다 확연히 많으면 실제 배치를 적는다. |

## 주석 (모든 프로젝트)

조건: 없음. 언어와 상관없이 넣는다.

```markdown
- 주석은 최대 2줄로 짧게 쓴다. 코드 동작을 풀어 설명하는 주석은 쓰지 않는다.
- 함수 본문과 객체 리터럴 안에는 주석을 쓰지 않는다. 필요하면 선언 위에 둔다.
- 코드를 읽어서 알 수 있는 내용은 주석으로 쓰지 않는다. 코드만으로 알 수 없는 이유·제약만 남긴다.
```

- 프로젝트가 JSDoc·docstring으로 API 문서를 생성하고 있으면(`typedoc`, `sphinx` 등 설정이 있으면) 공개 API의 문서 주석은 이 규칙에서 예외라고 한 줄 덧붙인다.
- 기존 코드의 주석을 이 규칙에 맞춰 지우지 않는다. 새로 쓰거나 고치는 코드에만 적용한다.

## Tailwind

조건: `stack.tailwind.used`가 true다. **Tailwind를 쓰지 않는 프로젝트에는 넣지 않는다.**

```markdown
- Tailwind 클래스는 정규형으로 쓴다(IntelliSense `suggestCanonicalClasses` 경고 0 — 예: `lg:right-[400px]` 대신 `lg:right-100`). 테마 토큰과 같은 값이면 토큰 유틸리티(`rounded-panel` 등)를 쓴다.
```

- 예시의 토큰 이름(`rounded-panel`)은 **프로젝트에 실제로 있는 토큰으로 바꾼다.** Tailwind v4는 CSS의 `@theme` 블록에서, v3는 `tailwind.config.*`의 `theme.extend`에서 찾는다. 토큰이 없으면 괄호 안 예시를 뺀다.
- `suggestCanonicalClasses`는 Tailwind v4 IntelliSense의 진단이다. `stack.tailwind.version`이 v3 계열이면 괄호 안 IntelliSense 언급을 빼고 "임의 값(`[...]`)보다 스케일 값을 우선한다"로 적는다.

## React · React Native

조건: `stack.frameworks`에 `react`나 `react-native`가 있다. 웹과 앱 모두 넣는다.

```markdown
- props나 다른 state로 계산되는 값은 state에 두지 않고 렌더 중에 계산한다. 함께 바뀌는 값은 state 하나로 묶거나 `useReducer`로 쓴다.
- state는 그 값을 쓰는 가장 가까운 공통 부모에 하나만 둔다. 같은 값을 여러 컴포넌트에 복사하지 않는다.
- `useEffect`는 외부 시스템과 동기화할 때만 쓴다(구독, 타이머, 네이티브·브라우저 API). 사용자 동작으로 일어나는 일은 이벤트 핸들러에서 처리한다.
- props가 바뀔 때 state를 맞추는 effect, effect 안에서 state를 연쇄로 바꾸는 코드를 쓰지 않는다. 초기화가 필요하면 `key`로 컴포넌트를 다시 만든다.
- effect가 읽는 값은 모두 의존성 배열에 넣는다. `exhaustive-deps` 경고를 끄지 않고, 의존성을 줄이려면 코드 구조를 고친다.
- 구독·타이머·리스너·요청을 시작하는 effect는 정리 함수(구독 해제, `clearTimeout`, `AbortController.abort`)를 반환한다.
- `useMemo`·`useCallback`은 메모된 자식이나 다른 훅의 의존성으로 넘길 때, 또는 계산이 실제로 무거울 때만 쓴다.
```

조정 규칙:

| 규칙 | 넣지 않거나 바꾸는 경우 |
|---|---|
| 서버 데이터 | `stack.libs.network`에 `@tanstack/react-query`·`swr` 등이 있으면 "서버 데이터는 `useState`+`useEffect`로 가져오지 않고 `<라이브러리>`로 가져온다"를 덧붙인다. |
| 전역 상태 | `stack.libs.state`에 라이브러리가 있으면 "여러 화면이 공유하는 클라이언트 상태만 `<라이브러리>`에 두고, 서버 데이터를 복사해 넣지 않는다"를 덧붙인다. 셀렉터로 필요한 값만 구독한다고 적는다. |
| 메모이제이션 | `stack.libs.reactCompiler`가 true면 `useMemo`·`useCallback` 줄 대신 "React Compiler가 메모이제이션을 맡으므로 `useMemo`·`useCallback`·`memo`를 새로 쓰지 않는다"를 적는다. |

## 웹

조건: `stack.platform`이 `"web"`이다.

```markdown
- 렌더링: 서버·클라이언트 경계를 지킨다. 클라이언트 컴포넌트는 상호작용이 필요한 가장 작은 단위로 둔다.
- 렌더링: 자주 바뀌는 state는 그 값을 쓰는 컴포넌트 가까이에 두어 리렌더 범위를 좁힌다.
- 네트워크: 같은 데이터를 여러 곳에서 따로 요청하지 않는다. 요청 위치와 캐시 무효화 지점을 한 곳에 둔다.
- 상태: 필터·탭·페이지처럼 공유하거나 새로고침 뒤에도 남아야 하는 상태는 URL에 둔다.
```

- `next`가 없고 서버 렌더링을 쓰지 않으면(Vite SPA 등) 서버·클라이언트 경계 줄을 뺀다.
- 프로젝트가 이미 쓰는 캐시·요청 방식(Server Component fetch, 쿼리 키 팩토리 등)이 있으면 그 이름으로 적는다.

## 앱

조건: `stack.platform`이 `"app"`이다.

```markdown
- 화면 스택: 화면 사이에는 id 같은 최소 파라미터만 넘기고, 객체 전체를 넘기지 않는다. 데이터는 도착한 화면에서 가져온다.
- 화면 스택: 스택에 남은 화면도 마운트되어 있다. 화면에 들어올 때 할 일은 포커스 이벤트(`useFocusEffect` 등)에서 하고, 벗어날 때 정리한다.
- 렌더링: 길이가 정해지지 않은 목록은 `FlatList`·`FlashList` 같은 가상화 목록으로 그리고, `ScrollView` 안에 `map`으로 그리지 않는다. `renderItem`과 `keyExtractor`는 안정적으로 둔다.
- 상태: 화면 하나에서만 쓰는 상태는 그 화면에 두고, 전역 저장소에 올리지 않는다.
- 네트워크: 오프라인·느린 네트워크를 전제로 로딩·실패·재시도 상태를 처리한다. 앱이 포그라운드로 돌아올 때 다시 가져올 데이터를 정한다.
```

- `stack.libs.navigation`에 `expo-router`가 있으면 파라미터 줄의 예를 `useLocalSearchParams`로, `@react-navigation/*`만 있으면 `route.params`로 적는다. 내비게이션 라이브러리가 없으면 화면 스택 줄을 뺀다.
- 프로젝트에 `@shopify/flash-list`가 없으면 `FlashList`를 예에서 뺀다.

## 그 밖의 언어

`package.json`이 없는 프로젝트(Python, Go 등)에는 위 JS/TS 규칙을 넣지 않는다. 그 언어의 표준 관례(PEP 8, `gofmt` 등)는 도구가 강제하므로 적지 않는다. 프로젝트에서 실제로 반복되는 관례(패키지 배치, 테스트 위치)만 코드에서 확인해 적는다.

## 규칙을 쓰는 방식

- 한 줄에 규칙 하나. 이유가 코드에서 자명하지 않을 때만 괄호로 짧게 덧붙인다.
- "~를 권장한다"가 아니라 "~를 쓴다"처럼 단정해서 쓴다. Claude가 따라야 할 규칙이지 토론거리가 아니다.
- 린터나 포매터가 이미 강제하는 것(세미콜론, 따옴표, 들여쓰기)은 적지 않는다.
