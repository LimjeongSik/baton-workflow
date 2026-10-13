# ui

[frontend-design](https://github.com/anthropics/claude-plugins-official) 스킬을 기반으로, 레퍼런스를 반영하고 분야에 맞춰 최적화한 UI/UX를 디자인합니다. **코드보다 목업 이미지가 먼저**이고, 사용자가 승인한 목업만 구현합니다.

## 설치

```
/plugin marketplace add LimjeongSik/my-tools-plugins
/plugin install ui@my-tools
```

`frontend-design@claude-plugins-official`이 의존성으로 함께 설치됩니다.

## 사용법

```
/ui:design 정비 기사용 작업 지시 대시보드 [레퍼런스 이미지 경로나 URL]
```

"이 레퍼런스처럼 랜딩 페이지 디자인해줘"처럼 자연어로 요청해도 됩니다.

## 흐름

1. frontend-design 스킬 호출 (필수)
2. 분야 판별(대시보드 / 모바일 앱 / 웹 앱 / 랜딩 / 커머스 / 콘텐츠)과 기존 디자인 시스템 확인
3. 레퍼런스 분석: 가져올 것과 베끼지 않을 것 구분
4. 디자인 계획 → 팔레트 검사(`palette-check.mjs`) → AI 티 점검
5. **목업 HTML → PNG 렌더링** (`.design/mockups/`)
6. **사용자 승인** (이대로 / 수정 후 다시 / 다른 방향)
7. 승인된 목업 기준으로 구현 → 스크린샷 비교 자기비평 → 보고

## 컬러 정책

새 디자인 시스템을 잡을 때는 밝은 면을 기본으로 합니다. 근거 없는 다크·네이비·인디고·보라 그라데이션, Tailwind 기본 팔레트, 크림·테라코타는 피합니다. 기존 디자인 시스템이나 레퍼런스가 정한 방향이 있으면 그것을 따릅니다.

## 목업 렌더링

Playwright(프로젝트 설치본 → 최신 버전) → 로컬 Chrome 계열 브라우저 순으로 찾습니다. 처음 실행할 때 Playwright 헤드리스 브라우저를 내려받을 수 있습니다.

목업은 `<저장소>/.design/mockups/`에 저장됩니다. 커밋하지 않으려면 `.gitignore`에 추가하세요.
