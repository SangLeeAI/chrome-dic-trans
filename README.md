# 실시간 영어 → 한글 자막 (Chrome Extension)

웹사이트에서 재생되는 **영어 오디오/영상**을 인식해, 페이지 위에 **실시간 한글 자막**으로 보여 주는 Chrome 확장 프로그램입니다.

**현재 버전: 1.2.8**

## 주요 기능

- **Local Whisper (GPU)** — 외부 Whisper 서버 URL 연결 (탭 오디오 직접 인식, 이어폰 OK)
- **파이프라인 STT** — 인식 중 다음 구간을 녹음해 청크를 버리지 않음
- **문장 단위 번역** — 오디오 청크가 아니라 `.` `!` `?` 로 끝나는 문장 완성 시 번역
- **최근 3문장 표시** — 짧은 문장이 와도 이전 긴 문장이 바로 사라지지 않음
- **반투명 자막 창** — 배경 투과율(기본 **50%**), **블러 없음**(영상 원본 그대로)
- **전체화면 지원** — Udemy 등 Fullscreen API 사용 시 자막을 fullscreen 요소 안으로 재배치
- **자막 창** — 기본 폭 **80vw** · 높이 **10vh**, ☰ 메뉴에서 폭·높이·위치 조절 (⠿ 드래그 이동, 다음 시작 시 복원)
- **문장 연속성** — 직전 영어 문장을 Whisper `prompt`로 전달
- Chrome Web Speech 폴백 (마이크)
- 영어 → 한국어 자동 번역 자막
- 드래그 가능한 플로팅 자막 박스
- 영어 원문 토글 (`EN` 버튼)
- 글자 크기(기본 **18px**) / 투과율(기본 **50%**) / 위치 / 청크 길이
- 연결 테스트 시 서버 `model` · `device` · `device_index` · `compute_type` 표시
- 무음 구간 / 인식 없음 상태 표시

## 설치 방법

1. Chrome에서 `chrome://extensions` 열기
2. 우측 상단 **개발자 모드** 켜기
3. **압축해제된 확장 프로그램을 로드합니다** 클릭
4. 이 폴더(`chrome-dic-trans`) 선택
5. 코드 갱신 후 확장 카드의 **새로고침** 클릭

## 사용 방법

### Local Whisper (추천)

로컬 Whisper 서버는 이 저장소에서 분리되어 다음 저장소로 옮겨졌습니다.

→ **[SangLeeAI/local-whisper](https://github.com/SangLeeAI/local-whisper)**

1. 위 저장소에서 GPU PC에 Whisper 서버를 설치·실행  
   (예: `http://192.168.2.247:9000`)
2. Chrome에서 영어 영상 탭 열기 (실제로 재생 중이어야 함)
3. 확장 팝업:
   - 엔진: **Local Whisper (GPU)**
   - URL: 서버 주소 (예: `http://192.168.2.247:9000`)
   - 청크 길이: 기본 **5.5초** (large-v3 서버는 5~6초 권장)
   - **연결 테스트** → `OK · model · device:index · compute` 확인
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
| **Local Whisper** | 탭 오디오 청크 (기본 5.5초, 3~8초 조절) | [local-whisper](https://github.com/SangLeeAI/local-whisper) 서버 |
| Web Speech | 마이크 | 폴백용 |

```
탭 오디오
  → WAV 청크 (16 kHz mono)
  → POST /v1/audio/transcriptions  (+ language=en, prompt=직전 영어)
  → 영어 텍스트 누적
  → 문장 완성 시(. ! ?) 한글 번역
  → 화면 자막
```

### Local Whisper 동작 세부 (v1.2.1)

| 항목 | 동작 |
|------|------|
| 오디오 포맷 | `chunk.wav` (PCM, 16 kHz, mono) — 서버 ffmpeg 의존 최소화 |
| 파이프라인 | STT 처리 중에도 다음 청크 녹음. **느린 large-v3에서도 청크 drop 없음** |
| prompt | 직전 인식 영어 문장(최대 약 220자)을 다음 요청에 전달해 문장 끊김 완화 |
| **번역 단위** | **문장 단위** — `.` `!` `?` 로 끝나면 번역. 미완성은 버퍼에 대기 |
| 강제 flush | 약 3.2초 무입력, 또는 16단어 이상 구두점 없음, 무음/중지 시 미완성 문장 번역 |
| 기본 청크 | **5.5초** — 서버 `large-v3` + beam search 지연에 맞춤 |
| 무음 처리 | `silent_audio` 시 미완성 버퍼 flush 후 상태 표시 |
| Health | `GET /health` → `ok` 확인. 연결 테스트에 device 정보 표시 |

서버 API (OpenAI 호환):

- `GET /health`
- `POST /v1/audio/transcriptions`  
  `multipart/form-data`: `file`, `model`, `language`, `response_format`, `prompt`(optional)

## 프로젝트 구조

```
chrome-dic-trans/
├── manifest.json          # MV3, v1.2.8
├── background.js          # 시작/중지, 탭 메시지, Whisper 테스트 중계
├── offscreen/
│   ├── offscreen.html
│   └── offscreen.js       # 탭 캡처 · WAV · Whisper · 번역 · Web Speech
├── content/
│   ├── content.js         # 자막 오버레이
│   └── content.css
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js           # 엔진/URL/청크/표시 설정
├── icons/
└── README.md
```

## 권한 설명

| 권한 | 용도 |
|------|------|
| `storage` | 엔진, URL, 청크, 표시 설정 저장 |
| `activeTab` / `scripting` / `tabs` | 자막 오버레이 |
| `tabCapture` | 탭 오디오 |
| `offscreen` | 백그라운드 인식 유지 |
| `http://*/*`, `https://*/*` | Whisper 서버 · 번역 API |

## 관련 저장소

| 저장소 | 설명 |
|--------|------|
| [chrome-dic-trans](https://github.com/SangLeeAI/chrome-dic-trans) | 이 Chrome 확장 (자막 UI · 탭 캡처 · 번역) |
| [local-whisper](https://github.com/SangLeeAI/local-whisper) | Windows/GPU용 로컬 Whisper HTTP 서버 |

## 변경 이력 (요약)

### 1.2.8

- 기본 자막 높이 **10vh**
- 폭·높이·위치(드래그 포함)를 저장해 **다음 자막 시작 시 복원**
- 팝업 설정 저장 시 드래그(`custom`) 위치를 덮어쓰지 않음

### 1.2.5–1.2.7

- 기본 자막 폭 **뷰포트 80%**, ☰ 메뉴로 폭/높이/위치 조절
- 높이 슬라이더가 고정 `vh` 높이에 반영되도록 수정
- 드래그 핸들(⠿) pointer 이벤트 + `!important` 위치 오버라이드

### 1.2.4

- 기본 창 크기 축소(18px 기준), 기본 투과율 **50%**
- 배경 **블러 제거** — 반투명만 적용해 영상이 선명하게 비침

### 1.2.3

- 자막 배경 **반투명** + 옵션 **배경 투과율** (높을수록 비침)
- **전체화면** 시 오버레이를 `fullscreenElement` 안으로 이동 (Udemy 등)

### 1.2.2

- 자막 창 **가로·세로 확대**, 최대 **최근 3문장** 동시 표시
- 기본 글자 크기 **22px → 18px** (약 20% 축소)
- 이전 문장 살짝 흐리게, 최신 문장·미완성(interim) 구분

### 1.2.1

- **문장 단위 번역** (청크 단위 번역 제거)
- `.` `!` `?` 완성 시에만 KO 번역, 미완성은 버퍼·interim 표시
- 무입력/긴 절/무음/중지 시 버퍼 flush

### 1.2.0

- Whisper STT **파이프라인** (청크 drop 제거)
- 직전 영어 문장 **`prompt` 연속성**
- 기본 청크 **5.5초**
- 무음/인식 없음 상태, 연결 테스트에 GPU device 정보 표시
- [local-whisper](https://github.com/SangLeeAI/local-whisper) 서버 분리·연동 문서화

### 1.1.x

- Local Whisper URL 모드, 탭 오디오 → WAV 전송
- Web Speech 폴백, 플로팅 자막 UI

## 제한 사항

- `chrome://` 등 일부 페이지에서는 동작하지 않습니다.
- Whisper 서버 코드는 이 저장소에 없습니다. → [local-whisper](https://github.com/SangLeeAI/local-whisper)
- 서버가 `large-v3`이면 인식 지연이 있을 수 있습니다. 청크 5~6초·파이프라인으로 보완합니다.
- 번역은 공개 번역 엔드포인트를 사용하므로 네트워크가 필요합니다.
- LAN 외부 공개는 인증이 없으니 권장하지 않습니다. (VPN/Tailscale 권장)

## 라이선스

MIT
