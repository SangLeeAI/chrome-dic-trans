# 실시간 영어 → 한글 자막 (Chrome Extension)

웹사이트에서 재생되는 **영어 오디오/영상**을 인식해, 페이지 위에 **실시간 한글 자막**으로 보여 주는 Chrome 확장 프로그램입니다.

## 주요 기능

- **Local Whisper (GPU)** — 외부 Whisper 서버 URL 연결 (탭 오디오 직접 인식)
- Chrome Web Speech 폴백 (마이크)
- 영어 → 한국어 자동 번역 자막
- 드래그 가능한 플로팅 자막 박스
- 영어 원문 토글 (`EN` 버튼)
- 글자 크기 / 배경 투명도 / 위치 / 청크 길이 설정

## 설치 방법

1. Chrome에서 `chrome://extensions` 열기
2. 우측 상단 **개발자 모드** 켜기
3. **압축해제된 확장 프로그램을 로드합니다** 클릭
4. 이 폴더(`chrome-dic-trans`) 선택

## 사용 방법

### Local Whisper (추천)

1. GPU PC 등에서 OpenAI 호환 Whisper 서버를 실행  
   (예: `http://192.168.2.247:9000`, `POST /v1/audio/transcriptions`, `GET /health`)
2. Chrome에서 영어 영상 탭 열기
3. 확장 팝업:
   - 엔진: **Local Whisper (GPU)**
   - URL: 서버 주소
   - **연결 테스트** → OK
4. **자막 시작**

탭 오디오를 캡처하므로 이어폰만 사용해도 인식됩니다.

### Web Speech (폴백)

- 엔진: **Chrome 마이크**
- 마이크 권한 허용 후 사용 (스피커 재생 시 유리)

### 자막 박스

| 조작 | 설명 |
|------|------|
| `⋮⋮` 드래그 | 위치 이동 |
| `EN` | 영어 원문 표시/숨김 |
| `×` | 자막 중지 |

## 인식 원리

| 엔진 | 입력 | 비고 |
|------|------|------|
| **Local Whisper** | 탭 오디오 청크 (3~8초) | 외부 Whisper HTTP API |
| Web Speech | 마이크 | 폴백용 |

흐름: `탭 오디오 → WAV 청크 → POST /v1/audio/transcriptions → 번역 → 자막`

## 프로젝트 구조

```
chrome-dic-trans/
├── manifest.json
├── background.js
├── offscreen/
│   ├── offscreen.html
│   └── offscreen.js
├── content/
│   ├── content.js
│   └── content.css
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── icons/
└── README.md
```

## 권한 설명

| 권한 | 용도 |
|------|------|
| `storage` | 설정 저장 |
| `activeTab` / `scripting` / `tabs` | 자막 오버레이 |
| `tabCapture` | 탭 오디오 |
| `offscreen` | 백그라운드 인식 |
| `http://*/*`, `https://*/*` | Whisper 서버 · 번역 API |

## 제한 사항

- `chrome://` 등 일부 페이지에서는 동작하지 않습니다.
- Whisper 서버는 이 저장소에 포함되지 않습니다. (별도 운영)
- 번역은 공개 번역 엔드포인트를 사용하므로 네트워크가 필요합니다.

## 라이선스

MIT
