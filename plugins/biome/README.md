# biome

프로젝트에 Biome을 설치하고, 프로젝트 종류에 맞춘 `biome.json`과 `.vscode` 설정을 만듭니다.

## 사용법

```
/biome:setup           # 기존 biome.json이 있으면 건너뜀
/biome:setup --force   # 기존 biome.json을 덮어씀
```

"biome 설치해줘", "포맷터·린터 설정해줘"처럼 말해도 됩니다. 설치하거나 파일을 쓰기 전에 항상 묻습니다.

## 만드는 파일

| 파일 | 내용 |
|---|---|
| `biome.json` | 포맷(들여쓰기 4칸, 줄 길이 100, 큰따옴표, 세미콜론), 린트 규칙, import 그룹 정렬 |
| `.vscode/settings.json` | JS/TS 파일 저장 시 Biome으로 포맷, `fixAll`·`organizeImports` 실행, type import 자동 추가 |
| `.vscode/extensions.json` | 추천 확장에 `biomejs.biome` 추가 |
| `package.json` | `lint`(`biome check`), `format`(`biome check --write`) 스크립트 (없을 때만) |

`.vscode/settings.json`이 이미 있으면 다른 설정은 그대로 두고 Biome 관련 키만 바꿉니다.

## 프로젝트 종류별로 달라지는 것

`package.json`의 의존성으로 종류를 판단합니다.

- **Next:** `.next`, `out`, `next-env.d.ts`를 제외하고, `next`·`react` domain을 켜고, import를 `react` → `next` → 패키지 순으로 묶습니다.
- **React Native / Expo:** `android`, `ios`(Expo는 `.expo`, `web-build`도)를 제외하고, `react` domain만 켭니다. DOM 전용 규칙(`noDangerouslySetInnerHtml`, a11y)은 넣지 않고, import 첫 그룹이 `react` → `react-native` → `expo`가 됩니다.
- **React(Vite 등):** `dist`를 제외하고 `react` domain을 켭니다.
- **TypeScript일 때만** type import 규칙과 정렬, VS Code의 type-only 자동 import를 넣습니다.
- **Tailwind·NativeWind를 쓸 때만** Tailwind 지시어 파싱을 켭니다.
- **tsconfig 별칭**(`@/*`, `~/*` 등)이 있으면 그 이름으로 `components` → `constants·hooks·lib·types` → 나머지 순서 그룹을 만듭니다.

특정 파일만 규칙을 끄는 `overrides`는 프로젝트마다 달라서 만들지 않습니다.

## 하지 않는 것

- ESLint·Prettier 설정이나 패키지를 지우지 않습니다.
- 기존 `lint`·`format` 스크립트를 묻지 않고 바꾸지 않습니다.
- 묻지 않고 `biome check --write`로 코드 전체를 고치지 않습니다.
