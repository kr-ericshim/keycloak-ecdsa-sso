# DESIGN.md — 서명 발급소(A) · 서명 검증소(B)

## 브리프

- **누가·어디서:** 발표자가 노트북 브라우저로 시연하고 캡처한다. 캡처는 16:9 PPT 안에 작게 들어가고, 강의실 프로젝터로 교수·조교가 본다. 그래서 밝은 화면, 높은 대비를 쓴다.
- **동사:** A는 증명서에 서명해 발급한다. B는 서명을 검증하고 위조를 잡아낸다.
- **느낌:** 관인처럼 믿음이 간다. 수식이 그대로 보인다. 두 기관이 한 신원을 공유한다.
- **Surface:** Operate(작업 도구). 다만 증명서 용지와 계산 노트는 캡처용 signature로 차별화 예산을 쓴다.
- **방향:** B+C 혼합(2026-11-09 사용자 선택). A는 보안 용지와 관인, B는 계산 노트.

## 토큰

```yaml
color:            # OKLCH, css/common.css :root
  paper-0:  oklch(0.99 0.003 150)    # 페이지 바탕
  paper-1:  oklch(0.965 0.012 150)   # 증명서 용지, 보조 면
  ink-900:  oklch(0.23 0.02 160)     # 본문
  ink-600:  oklch(0.45 0.015 160)    # 보조 텍스트
  bond-green: oklch(0.44 0.09 160)   # A accent — 증권·보안 인쇄 녹색
  seal-red:   oklch(0.52 0.19 28)    # 인주. 관인과 "위조" 판정에만 쓴다
  notebook-ink: oklch(0.42 0.13 258) # B accent — 계산 노트 잉크
  notebook-grid: oklch(0.93 0.025 245)
  ok-green: oklch(0.5 0.13 150)      # "진본" 판정
semantic:
  accent: A=bond-green, B=notebook-ink   # body[data-service]로 전환
  danger: seal-red                        # 위조 = 인주색 도장. 의미가 겹치도록 의도함
type:
  ui:  Pretendard Variable — 15/1.55 본문, 13 보조, 12 캡션
  doc: Nanum Myeongjo — 증명서 용지 안에서만 (종류 40px, 필드 17px)
  mono: JetBrains Mono — 해시, r, s, 곡선 값, tabular-nums
space: 4px 기반 (4, 8, 12, 16, 20, 24, 32, 40, 48)
radius: control 6 / panel 10 / paper 2
depth: border only (그림자 없음). 증명서는 이중 테두리로 "종이"를 표현
motion:
  - 관인 찍힘 420ms (발급 직후 1회)
  - 검증 단계 순차 표시 260ms + 90ms 간격, 곡선 덧셈 선 700ms (결과 표시 1회)
  - prefers-reduced-motion: 전부 즉시
signature:
  A: kid와 서명값 r로 만든 인주색 관인 + 하이포트로코이드 보안 무늬
  B: 모눈 계산 노트 위의 u₁, u₂, R 수식 레일과 곡선 점 덧셈 개념도
shared: 상단 SSO 신원 칩과 하단 "이 로그인 세션" 패널은 두 서비스에서 똑같이 생겼다
```

## Rejecting

- Inter 단일 서체 → Pretendard(한글 UI) + 나눔명조(증명서 문서 목소리) + mono(수치). 근거: 한국어 증명서, 수치 비교.
- 무채색 SaaS 카드 + 파란 accent → 증권 녹 / 계산 노트 남색. 근거: 보안 인쇄 용지, 수학 노트라는 도메인 사물.
- 크림 바탕 + 세리프 + 테라코타 → 연녹 보안지 + 인주 빨강. 세리프는 증명서 용지 안에서만 쓴다.
- 장식 KPI 타일, 인사 배너 → 작업 표면(발급 폼, 검증 입력)부터 시작.

## 파일

- `service-a/public/css/common.css`, `service-a/public/js/session.js`는 B와 같은 파일이다. A에서 고치고 `service-b/public/`로 복사한다.
- 배포 주소는 각 `public/config.js`의 `peerUrl`만 바꾼다.

## Decision log

| 날짜 | 결정 | 근거 | 기각한 대안 |
|---|---|---|---|
| 2026-11-09 | A=보안 용지·관인, B=계산 노트 | 캡처에서 두 서비스가 바로 구분되고, ECC 설명에 수식이 필요함 | 기관 표준(인상이 약함), 단일 스타일 통일 |
| 2026-11-09 | SSO 증거로 auth_time과 서비스 세션 생성 시각을 나란히 표시 | 과제 검증 항목 "추가 로그인 없이 접속"을 화면 하나로 증명 | 문구로만 설명 |
| 2026-11-09 | 위조 시연 버튼(받는 사람 마지막 글자 +1) | 발표에서 위변조 탐지를 한 번에 보여줌 | 사용자가 직접 JSON 수정 |
