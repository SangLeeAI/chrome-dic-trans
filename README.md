# 실시간 영어 → 한글 자막 (Chrome Extension)

웹사이트에서 재생되는 **영어 오디오/영상**을 인식해, 페이지 위에 **실시간 한글 자막**으로 보여 주는 Chrome 확장 프로그램입니다.

## 주요 기능

- **Local Whisper (GPU)** — 탭 오디오 직접 인식 (이어폰 OK, RTX 3090 등)
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

## 사용 방법 (Local Whisper 추천)

### A. Windows GPU PC

1. `local-whisper` 폴더에서 `setup.bat` → `open-firewall.bat`(관리자) → `run.bat`
2. `http://0.0.0.0:9000` 으로 기동 확인
3. IP 확인 (`ipconfig`) 예: `192.168.2.247`

### B. Chrome (같은 LAN의 아무 PC)

1. 이 확장 로드 / 새로고침 (`chrome://extensions`)
2. YouTube 등 **영어 영상 탭** 열기
3. 확장 팝업에서:
   - 엔진: **Local Whisper (GPU)**
   - URL: `http://192.168.2.247:9000` (본인 GPU PC IP)
   - **연결 테스트** → OK 확인
4. **자막 시작**
5. 페이지 하단에 한글 자막 표시

탭 오디오를 캡처하므로 **이어폰만 사용해도** 인식됩니다.

### 자막 박스

| 조작 | 설명 |
|------|------|
| `⋮⋮` 드래그 | 위치 이동 |
| `EN` | 영어 원문 표시/숨김 |
| `×` | 자막 중지 |

## 인식 원리

| 엔진 | 입력 | 비고 |
|------|------|------|
| **Local Whisper** | 탭 오디오 청크 (3~8초) | GPU PC `faster-whisper` 서버, 비용 0 |
| Web Speech | 마이크 | 폴백용, 스피커 재생 시 유리 |

흐름: `탭 오디오 → MediaRecorder → POST /v1/audio/transcriptions → 번역 → 자막`

## 프로젝트 구조

```
chrome-dic-trans/
├── manifest.json          # MV3 매니페스트
├── background.js          # 서비스 워커 (시작/중지 조율)
├── offscreen/
│   ├── offscreen.html
│   └── offscreen.js       # 음성 인식 + 번역
├── content/
│   ├── content.js         # 자막 오버레이
│   └── content.css
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js           # 시작/중지 UI · 설정
├── icons/
└── README.md
```

## 권한 설명

| 권한 | 용도 |
|------|------|
| `storage` | 글자 크기 등 설정 저장 |
| `activeTab` / `scripting` / `tabs` | 현재 탭에 자막 오버레이 표시 |
| `tabCapture` | 탭 오디오 스트림 연결 |
| `offscreen` | 백그라운드 음성 인식 유지 |
| translate host | 영어→한글 번역 요청 |

## 제한 사항

- `chrome://`, Chrome 웹스토어 등 일부 페이지에서는 동작하지 않습니다.
- 소음이 크거나 억양이 강한 경우 인식률이 떨어질 수 있습니다.
- 번역은 공개 번역 엔드포인트를 사용하므로 네트워크가 필요합니다.
- 서비스 워커가 재시작되면 자막을 다시 시작해야 할 수 있습니다.

## 개발 메모

- Manifest V3
- 인식: `webkitSpeechRecognition` (continuous + interim)
- 번역: Google Translate 공개 엔드포인트 → 실패 시 MyMemory 폴백

## 로컬 Whisper (Windows + RTX 3090)

API 비용 없이 GPU PC에서 돌리려면:

→ [`local-whisper/README-WINDOWS.md`](local-whisper/README-WINDOWS.md)

1. `local-whisper` 폴더를 Windows로 복사  
2. `setup.bat` → `run.bat`  
3. http://127.0.0.1:9000/health 확인  

## 라이선스

MIT
