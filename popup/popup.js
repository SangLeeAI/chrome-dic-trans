const $ = (id) => document.getElementById(id);

const els = {
  statusDot: $("statusDot"),
  statusText: $("statusText"),
  toggleBtn: $("toggleBtn"),
  hintText: $("hintText"),
  sttEngine: $("sttEngine"),
  whisperFields: $("whisperFields"),
  whisperUrl: $("whisperUrl"),
  testWhisperBtn: $("testWhisperBtn"),
  testResult: $("testResult"),
  chunkMs: $("chunkMs"),
  chunkMsVal: $("chunkMsVal"),
  sourceLang: $("sourceLang"),
  fontSize: $("fontSize"),
  fontSizeVal: $("fontSizeVal"),
  opacity: $("opacity"),
  opacityVal: $("opacityVal"),
  position: $("position"),
};

let isRunning = false;

function setRunningUI(running) {
  isRunning = running;
  els.statusDot.classList.toggle("on", running);
  els.statusText.textContent = running ? "실행 중" : "중지됨";
  els.toggleBtn.textContent = running ? "자막 중지" : "자막 시작";
  els.toggleBtn.classList.toggle("stop", running);
}

function syncEngineUI() {
  const whisper = els.sttEngine.value === "whisper";
  els.whisperFields.classList.toggle("hidden", !whisper);
  if (whisper) {
    els.hintText.textContent =
      "Local Whisper 서버를 켠 뒤, 영어 영상이 재생 중인 탭에서 시작하세요.";
  } else {
    els.hintText.textContent =
      "마이크 권한이 필요합니다. 스피커로 재생하면 인식됩니다.";
  }
}

function readSettingsFromUI() {
  return {
    sttEngine: els.sttEngine.value,
    whisperUrl: els.whisperUrl.value.trim().replace(/\/+$/, ""),
    chunkMs: Number(els.chunkMs.value),
    sourceLang: els.sourceLang.value,
    fontSize: Number(els.fontSize.value),
    opacity: Number(els.opacity.value) / 100,
    position: els.position.value,
  };
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get({
    sttEngine: "whisper",
    whisperUrl: "http://192.168.2.247:9000",
    chunkMs: 5500,
    sourceLang: "en-US",
    fontSize: 22,
    opacity: 0.85,
    position: "bottom",
  });

  els.sttEngine.value = stored.sttEngine;
  els.whisperUrl.value = stored.whisperUrl;
  els.chunkMs.value = stored.chunkMs;
  els.chunkMsVal.textContent = (stored.chunkMs / 1000).toFixed(1);
  els.sourceLang.value = stored.sourceLang;
  els.fontSize.value = stored.fontSize;
  els.fontSizeVal.textContent = String(stored.fontSize);
  els.opacity.value = Math.round(stored.opacity * 100);
  els.opacityVal.textContent = String(Math.round(stored.opacity * 100));
  els.position.value = stored.position;
  syncEngineUI();
}

async function saveSettings() {
  await chrome.storage.sync.set(readSettingsFromUI());
}

async function refreshStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    setRunningUI(!!status?.isRunning);
  } catch {
    setRunningUI(false);
  }
}

function shortError(msg) {
  const s = String(msg || "실패");
  if (/Failed to fetch|NetworkError|ERR_CONNECTION|connection refused/i.test(s)) {
    return "네트워크 차단/방화벽/IP 확인 필요";
  }
  if (/timeout|TIMED_OUT/i.test(s)) {
    return "시간 초과 (방화벽 또는 다른 네트워크)";
  }
  return s.length > 80 ? s.slice(0, 80) + "…" : s;
}

async function testWhisper() {
  const url = els.whisperUrl.value.trim().replace(/\/+$/, "");
  if (!url) {
    els.testResult.textContent = "URL을 입력하세요.";
    els.testResult.className = "test-result err";
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    els.testResult.textContent = "http:// 를 포함하세요";
    els.testResult.className = "test-result err";
    return;
  }

  els.testWhisperBtn.disabled = true;
  els.testResult.textContent = "확인 중…";
  els.testResult.className = "test-result";
  await saveSettings();

  try {
    const res = await chrome.runtime.sendMessage({
      type: "TEST_WHISPER",
      whisperUrl: url,
    });
    if (res?.ok) {
      const model = res.data?.model || "?";
      const device = res.data?.device || "?";
      const idx =
        res.data?.device_index != null ? `:${res.data.device_index}` : "";
      const compute = res.data?.compute_type
        ? ` · ${res.data.compute_type}`
        : "";
      els.testResult.textContent = `OK · ${model} · ${device}${idx}${compute}`;
      els.testResult.className = "test-result ok";
      els.hintText.textContent = `Whisper 연결됨: ${url}`;
    } else {
      const err = shortError(res?.error);
      els.testResult.textContent = err;
      els.testResult.className = "test-result err";
      els.hintText.textContent =
        `연결 실패: ${res?.error || err}. ` +
        "Windows에서 open-firewall.bat(관리자) 재실행, 네트워크 프로필이 공용이면 방화벽 all 프로필 허용, " +
        "원격 브라우저에서 http://192.168.2.247:9000/health 직접 열어보세요.";
    }
  } catch (e) {
    els.testResult.textContent = shortError(e?.message || e);
    els.testResult.className = "test-result err";
    els.hintText.textContent = String(e?.message || e);
  } finally {
    els.testWhisperBtn.disabled = false;
  }
}

async function toggle() {
  els.toggleBtn.disabled = true;
  try {
    if (isRunning) {
      const res = await chrome.runtime.sendMessage({ type: "STOP_CAPTIONS" });
      if (res?.ok) {
        setRunningUI(false);
        els.hintText.textContent = "자막이 중지되었습니다.";
      }
    } else {
      await saveSettings();
      const settings = readSettingsFromUI();
      if (settings.sttEngine === "whisper" && !settings.whisperUrl) {
        els.hintText.textContent = "Whisper 서버 URL을 입력하세요.";
        return;
      }
      const res = await chrome.runtime.sendMessage({
        type: "START_CAPTIONS",
        settings,
      });
      if (res?.ok) {
        setRunningUI(true);
        if (res.mode === "whisper") {
          els.hintText.textContent = `Whisper 자막 실행 중 → ${res.whisperUrl || settings.whisperUrl}`;
        } else if (res.mode === "tab+mic") {
          els.hintText.textContent = "탭 오디오 연결됨. 마이크가 음성을 인식합니다.";
        } else {
          els.hintText.textContent = "마이크 인식 모드입니다.";
        }
      } else {
        els.hintText.textContent = res?.error || "시작할 수 없습니다.";
        setRunningUI(false);
      }
    }
  } catch (e) {
    els.hintText.textContent = e?.message || String(e);
  } finally {
    els.toggleBtn.disabled = false;
  }
}

els.toggleBtn.addEventListener("click", toggle);
els.testWhisperBtn.addEventListener("click", testWhisper);

els.sttEngine.addEventListener("change", () => {
  syncEngineUI();
  saveSettings();
});

els.whisperUrl.addEventListener("change", saveSettings);
els.whisperUrl.addEventListener("blur", saveSettings);

els.chunkMs.addEventListener("input", () => {
  els.chunkMsVal.textContent = (Number(els.chunkMs.value) / 1000).toFixed(1);
  saveSettings();
});

els.fontSize.addEventListener("input", () => {
  els.fontSizeVal.textContent = els.fontSize.value;
  saveSettings();
});

els.opacity.addEventListener("input", () => {
  els.opacityVal.textContent = els.opacity.value;
  saveSettings();
});

els.sourceLang.addEventListener("change", saveSettings);
els.position.addEventListener("change", saveSettings);

await loadSettings();
await refreshStatus();
