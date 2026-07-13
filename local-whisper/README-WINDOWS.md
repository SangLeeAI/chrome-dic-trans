# Windows + RTX 3090 로컬 Whisper 설치

비용 **0원**. GPU PC에서 Whisper를 돌리고, 나중에 크롬 확장이 `http://127.0.0.1:9000` 으로 호출합니다.

## 필요 사항

| 항목 | 설명 |
|------|------|
| GPU | RTX 3090 (다른 NVIDIA GPU도 가능) |
| OS | Windows 10 / 11 |
| 드라이버 | [NVIDIA GeForce 드라이버](https://www.nvidia.com/Download/index.aspx) 최신 |
| Python | [3.11 또는 3.12](https://www.python.org/downloads/) — 설치 시 **Add to PATH** 체크 |
| ffmpeg | 권장: `winget install Gyan.FFmpeg` |

## 1분 설치

1. 이 폴더(`local-whisper`)를 Windows PC로 복사
2. **`setup.bat`** 더블클릭 → 끝날 때까지 대기
3. **`open-firewall.bat`** 우클릭 → **관리자 권한으로 실행** (외부/LAN 접속용, 최초 1회)
4. **`run.bat`** 더블클릭 → 검은 창 유지  
   - 기본 바인딩: **`0.0.0.0:9000`** (다른 PC에서 접속 가능)
5. 확인:
   - 이 PC: http://127.0.0.1:9000/health  
   - 다른 기기: http://\<Windows-PC-IP\>:9000/health  
   - `"ok": true` 이면 성공

첫 실행 시 모델 다운로드(수 GB). 인터넷 필요.

### 이 PC IP 확인

```bat
ipconfig
```

`무선 LAN` / `이더넷` 의 **IPv4 주소** (예: `192.168.0.15`)를 사용합니다.

## 동작 확인

PowerShell 또는 CMD:

```bat
curl http://127.0.0.1:9000/health
```

오디오 파일 테스트:

```bat
test.bat C:\path\to\english.mp3
```

또는:

```bat
curl -X POST http://127.0.0.1:9000/v1/audio/transcriptions -F "file=@C:\path\to\audio.mp3" -F "language=en"
```

## 모델 / 성능 조절

`run.bat` 안 변수를 수정:

```bat
set WHISPER_MODEL=large-v3-turbo
set WHISPER_DEVICE=cuda
set WHISPER_COMPUTE_TYPE=float16
```

| 설정 | 추천 | 설명 |
|------|------|------|
| `large-v3-turbo` | ✅ 기본 | 실시간 자막에  Bal음 |
| `large-v3` | 품질↑ | 조금 더 무거움 |
| `medium` | 가벼움 | VRAM/속도 여유 |
| `float16` | ✅ 3090 | 품질/속도 균형 |
| `int8_float16` | 더 빠름 | 품질 약간↓ |

## GPU가 안 잡힐 때

1. CMD에서 `nvidia-smi` → 3090이 보여야 함  
2. 안 보이면 NVIDIA 드라이버 재설치  
3. `run.bat` 로그에 `CUDA failed, using CPU` 나오면 GPU 미사용  
4. Python 재설치 시 **PATH** 다시 확인 후 `setup.bat` 재실행  

## 방화벽 / 다른 PC에서 접속

`run.bat` 기본값은 이미 **`WHISPER_HOST=0.0.0.0`** 입니다 (모든 네트워크 인터페이스 listen).

1. **`open-firewall.bat`** 를 관리자 권한으로 실행 (포트 9000 인바운드 허용)
2. Windows PC IP 확인: `ipconfig` → IPv4
3. 다른 기기에서:
   ```text
   http://192.168.x.x:9000/health
   ```
4. 크롬 확장 / 클라이언트 URL 예:
   ```text
   http://192.168.x.x:9000/v1/audio/transcriptions
   ```

### 보안

- **집/회사 LAN** 안에서만 쓰는 것을 권장합니다.
- 인터넷에 공유기 포트포워딩으로 열지 마세요 (인증 없음).
- 꼭 원격이 필요하면 VPN 또는 터널(예: Tailscale)을 쓰세요.
- 로컬 전용으로 되돌리려면 `run.bat` 에서 `set WHISPER_HOST=127.0.0.1`

## 폴더 구조

```
local-whisper/
├── setup.bat          # 최초 1회
├── run.bat            # 서버 실행
├── test.bat           # 오디오 테스트
├── server.py          # FastAPI + faster-whisper
├── requirements.txt
└── README-WINDOWS.md
```

## API (OpenAI 호환)

```
POST /v1/audio/transcriptions
Content-Type: multipart/form-data

file: <audio>
language: en
response_format: json   # 또는 text, verbose_json
```

응답 예:

```json
{
  "text": "Hello everyone, welcome to the lecture.",
  "language": "en",
  "elapsed_sec": 0.42
}
```

## 다음 단계

서버가 정상(`ok: true`)이면 크롬 확장에 **Local Whisper URL** 모드를 붙여  
탭 오디오 → 3090 → 한글 자막으로 연결할 수 있습니다.
