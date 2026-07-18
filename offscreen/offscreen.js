/**
 * Offscreen: tab audio → Local Whisper (or Web Speech) → EN→KO captions.
 */

const SpeechRecognition =
  self.SpeechRecognition || self.webkitSpeechRecognition;

let isActive = false;
let sourceLang = "en-US";
let sttEngine = "whisper"; // whisper | webspeech
let whisperBaseUrl = "http://127.0.0.1:9000";
let chunkMs = 4500;

let tabAudioEl = null;
let tabStream = null;
let mediaRecorder = null;
let recordTimer = null;
let chunkLoopRunning = false;
let recognition = null;

let translateQueue = Promise.resolve();
const recentTranslations = new Map();
let lastInterimText = "";
let lastInterimSentAt = 0;
/** Last final English transcript — sent as Whisper `prompt` for continuity */
let lastEnglishPrompt = "";
const PROMPT_MAX_CHARS = 220;

/** Sentence-level translation buffer (not per audio chunk) */
let sentenceBuffer = "";
let lastKoCaption = "";
let sentenceFlushTimer = null;
const SENTENCE_FLUSH_IDLE_MS = 3200; // no new text → force-translate partial
const SENTENCE_FORCE_WORDS = 16; // long clause without .!?

function postStatus(status, detail = "") {
  chrome.runtime
    .sendMessage({ type: "CAPTION_STATUS", status, detail })
    .catch(() => {});
}

function postError(error) {
  chrome.runtime
    .sendMessage({ type: "CAPTION_ERROR", error })
    .catch(() => {});
}

function postCaption(text, original, interim) {
  chrome.runtime
    .sendMessage({
      type: "CAPTION_RESULT",
      text,
      original,
      interim,
    })
    .catch(() => {});
}

function normalizeBaseUrl(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "");
}

async function translateEnToKo(text) {
  const key = text.trim().toLowerCase();
  if (!key) return "";
  if (recentTranslations.has(key)) return recentTranslations.get(key);

  try {
    const url =
      "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ko&dt=t&q=" +
      encodeURIComponent(text);
    const res = await fetch(url);
    if (!res.ok) throw new Error("translate http " + res.status);
    const data = await res.json();
    const translated = (data?.[0] || [])
      .map((seg) => seg?.[0] || "")
      .join("")
      .trim();
    if (translated) {
      recentTranslations.set(key, translated);
      if (recentTranslations.size > 100) {
        recentTranslations.delete(recentTranslations.keys().next().value);
      }
      return translated;
    }
  } catch (e) {
    console.warn("Google translate failed", e);
  }

  try {
    const url =
      "https://api.mymemory.translated.net/get?langpair=en|ko&q=" +
      encodeURIComponent(text.slice(0, 450));
    const res = await fetch(url);
    if (!res.ok) throw new Error("mymemory http " + res.status);
    const data = await res.json();
    const translated = data?.responseData?.translatedText?.trim() || "";
    if (translated && !translated.toLowerCase().includes("query length")) {
      recentTranslations.set(key, translated);
      return translated;
    }
  } catch (e) {
    console.warn("MyMemory translate failed", e);
  }

  return text;
}

function enqueueTranslate(original, interim) {
  translateQueue = translateQueue
    .then(async () => {
      if (!isActive || !original?.trim()) return;
      if (interim && original.trim().split(/\s+/).length < 2) {
        postCaption(original, original, true);
        return;
      }
      const ko = await translateEnToKo(original);
      if (!isActive) return;
      if (!interim) lastKoCaption = ko || original;
      postCaption(ko || original, original, interim);
    })
    .catch((e) => console.warn("translate queue", e));
}

/** Join Whisper chunks; drop simple word overlaps at the boundary. */
function joinUtterance(prev, next) {
  const a = (prev || "").trim();
  const b = (next || "").trim();
  if (!a) return b;
  if (!b) return a;
  if (a.endsWith(b)) return a;
  if (b.startsWith(a)) return b;

  const aw = a.split(/\s+/);
  const bw = b.split(/\s+/);
  const max = Math.min(aw.length, bw.length, 10);
  for (let n = max; n > 0; n--) {
    const tail = aw.slice(-n).join(" ").toLowerCase();
    const head = bw.slice(0, n).join(" ").toLowerCase();
    if (tail === head) {
      const rest = bw.slice(n).join(" ");
      return rest ? `${a} ${rest}` : a;
    }
  }
  return `${a} ${b}`;
}

/**
 * Split complete English sentences ending with . ! ?
 * Leaves the unfinished tail in `rest`.
 */
function splitCompleteSentences(text) {
  const src = (text || "").trim();
  if (!src) return { sentences: [], rest: "" };

  // End of sentence: . ! ? (optionally followed by closing quotes/brackets)
  const endRe = /[.!?]+(?:["'\u201d\u2019)\]]+)?(?=\s+|$)/g;
  const sentences = [];
  let last = 0;
  let m;
  while ((m = endRe.exec(src)) !== null) {
    const end = m.index + m[0].length;
    const sentence = src.slice(last, end).trim();
    if (sentence && /[.!?]/.test(sentence)) {
      sentences.push(sentence);
      last = end;
    }
  }
  const rest = src.slice(last).replace(/^\s+/, "");
  return { sentences, rest };
}

function wordCount(s) {
  return (s || "").trim().split(/\s+/).filter(Boolean).length;
}

function clearSentenceFlushTimer() {
  if (sentenceFlushTimer) {
    clearTimeout(sentenceFlushTimer);
    sentenceFlushTimer = null;
  }
}

function scheduleSentenceFlush() {
  clearSentenceFlushTimer();
  sentenceFlushTimer = setTimeout(() => {
    sentenceFlushTimer = null;
    if (!isActive) return;
    flushSentenceBuffer("idle");
  }, SENTENCE_FLUSH_IDLE_MS);
}

function showPartialCaption() {
  if (!sentenceBuffer.trim()) return;
  // Content script keeps last 3 finals; interim is only the unfinished English
  postCaption("", sentenceBuffer, true);
}

/**
 * Feed STT text into the sentence buffer and translate only complete sentences.
 */
function feedSentenceBuffer(piece) {
  const t = (piece || "").trim();
  if (!t) return;

  sentenceBuffer = joinUtterance(sentenceBuffer, t);
  drainCompleteSentences();

  // Long spoken clause with no punctuation — force a unit
  if (wordCount(sentenceBuffer) >= SENTENCE_FORCE_WORDS) {
    flushSentenceBuffer("length");
    return;
  }

  if (sentenceBuffer) {
    showPartialCaption();
    scheduleSentenceFlush();
  }
}

function drainCompleteSentences() {
  const { sentences, rest } = splitCompleteSentences(sentenceBuffer);
  sentenceBuffer = rest;
  for (const s of sentences) {
    enqueueTranslate(s, false);
  }
}

function flushSentenceBuffer(reason = "manual") {
  clearSentenceFlushTimer();
  const pending = sentenceBuffer.trim();
  if (!pending) return;
  sentenceBuffer = "";
  // Treat as one caption unit even without terminal punctuation
  enqueueTranslate(pending, false);
  console.debug("[caption] flush sentence buffer:", reason, pending.slice(0, 80));
}

function resetSentenceBuffer() {
  clearSentenceFlushTimer();
  sentenceBuffer = "";
  lastKoCaption = "";
}

// ---------- Tab audio ----------

async function attachTabAudio(streamId) {
  if (!streamId) return false;
  try {
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });

    tabAudioEl = document.createElement("audio");
    tabAudioEl.srcObject = tabStream;
    tabAudioEl.autoplay = true;
    await tabAudioEl.play().catch(() => {});
    return true;
  } catch (e) {
    console.warn("tab audio attach failed", e);
    stopTabAudio();
    return false;
  }
}

function stopTabAudio() {
  stopChunkLoop();
  if (tabAudioEl) {
    try {
      tabAudioEl.pause();
      tabAudioEl.srcObject = null;
    } catch {
      // ignore
    }
    tabAudioEl = null;
  }
  if (tabStream) {
    tabStream.getTracks().forEach((t) => t.stop());
    tabStream = null;
  }
}

const TARGET_SAMPLE_RATE = 16000;

function encodeWavMono16(float32Samples, sampleRate) {
  const numSamples = float32Samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits
  writeStr(36, "data");
  view.setUint32(40, numSamples * 2, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    let s = Math.max(-1, Math.min(1, float32Samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Capture tab audio for `ms` as 16kHz mono WAV (no ffmpeg needed on server).
 */
function recordOneChunkWav(stream, ms) {
  return new Promise(async (resolve, reject) => {
    if (!stream || stream.getAudioTracks().every((t) => t.readyState !== "live")) {
      reject(new Error("탭 오디오 스트림이 없습니다."));
      return;
    }

    (async () => {
      let audioCtx;
      try {
        audioCtx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
      } catch {
        audioCtx = new AudioContext();
      }

      // Critical: suspended context yields silence
      if (audioCtx.state === "suspended") {
        try {
          await audioCtx.resume();
        } catch (e) {
          console.warn("AudioContext.resume failed", e);
        }
      }

      const source = audioCtx.createMediaStreamSource(stream);
      const samples = [];
      const gotRate = audioCtx.sampleRate;

      const bufferSize = 4096;
      const processor = audioCtx.createScriptProcessor(bufferSize, 1, 1);
      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        // copy immediately — underlying buffer is reused
        samples.push(Float32Array.from(input));
      };

      // Keep graph alive; very low gain avoids feedback while not zeroing graph
      const mute = audioCtx.createGain();
      mute.gain.value = 0.0001;
      source.connect(processor);
      processor.connect(mute);
      mute.connect(audioCtx.destination);

      mediaRecorder = {
        stop: () => {
          try {
            processor.disconnect();
            source.disconnect();
            mute.disconnect();
          } catch {
            // ignore
          }
        },
      };

      recordTimer = setTimeout(async () => {
        recordTimer = null;
        try {
          processor.disconnect();
          source.disconnect();
          mute.disconnect();
        } catch {
          // ignore
        }

        let pcm = new Float32Array(0);
        if (samples.length) {
          let total = 0;
          for (const s of samples) total += s.length;
          const merged = new Float32Array(total);
          let off = 0;
          for (const s of samples) {
            merged.set(s, off);
            off += s.length;
          }

          if (gotRate !== TARGET_SAMPLE_RATE && merged.length > 0) {
            const newLen = Math.max(
              1,
              Math.round((merged.length * TARGET_SAMPLE_RATE) / gotRate)
            );
            pcm = new Float32Array(newLen);
            for (let i = 0; i < newLen; i++) {
              const src = (i * gotRate) / TARGET_SAMPLE_RATE;
              const i0 = Math.floor(src);
              const i1 = Math.min(i0 + 1, merged.length - 1);
              const t = src - i0;
              pcm[i] = merged[i0] * (1 - t) + merged[i1] * t;
            }
          } else {
            pcm = merged;
          }
        }

        // Soft gain if quiet
        let peak = 0;
        let sumSq = 0;
        for (let i = 0; i < pcm.length; i++) {
          const a = Math.abs(pcm[i]);
          if (a > peak) peak = a;
          sumSq += pcm[i] * pcm[i];
        }
        const rms = pcm.length ? Math.sqrt(sumSq / pcm.length) : 0;
        if (peak > 0 && peak < 0.12) {
          const gain = Math.min(0.7 / peak, 10);
          for (let i = 0; i < pcm.length; i++) {
            pcm[i] = Math.max(-1, Math.min(1, pcm[i] * gain));
          }
        }

        try {
          await audioCtx.close();
        } catch {
          // ignore
        }

        if (rms < 0.0003) {
          console.warn("Near-silent chunk rms=", rms, "peak=", peak);
        }

        resolve(encodeWavMono16(pcm, TARGET_SAMPLE_RATE));
      }, ms);
    })().catch(reject);
  });
}

async function sendToWhisper(blob) {
  if (!blob || blob.size < 1000) {
    return { text: "", warning: "empty_blob" };
  }

  const base = normalizeBaseUrl(whisperBaseUrl);
  const endpoint = `${base}/v1/audio/transcriptions`;
  const form = new FormData();
  form.append("file", blob, "chunk.wav");
  form.append("model", "whisper-1");
  form.append("language", "en");
  form.append("response_format", "json");
  // Continuity across short live chunks (server accepts OpenAI-style prompt)
  if (lastEnglishPrompt) {
    form.append("prompt", lastEnglishPrompt);
  }

  const res = await fetch(endpoint, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    let body = await res.text().catch(() => "");
    try {
      const j = JSON.parse(body);
      body = j.error || j.detail || body;
    } catch {
      // keep text
    }
    throw new Error(`Whisper HTTP ${res.status}: ${String(body).slice(0, 220)}`);
  }

  const data = await res.json();
  return {
    text: (data?.text || "").trim(),
    warning: data?.warning || null,
    stats: data?.stats || null,
    device: data?.device || null,
    elapsed_sec: data?.elapsed_sec,
  };
}

function rememberPrompt(englishText) {
  const t = (englishText || "").trim();
  if (!t) return;
  // Keep a short tail so the next chunk continues naturally
  lastEnglishPrompt =
    t.length > PROMPT_MAX_CHARS ? t.slice(-PROMPT_MAX_CHARS) : t;
}

async function processWhisperBlob(blob) {
  if (!isActive) return;
  try {
    postStatus("listening", "Whisper 인식 중…");
    const result = await sendToWhisper(blob);
    if (!isActive) return;

    if (result?.warning === "silent_audio") {
      // End of speech-ish — flush any unfinished clause
      flushSentenceBuffer("silence");
      postStatus("listening", "무음 구간");
      return;
    }
    if (result?.warning === "empty_blob") {
      postStatus("listening", "빈 오디오");
      return;
    }

    const text = result?.text || "";
    if (!text || text.length < 2) {
      const rms = result?.stats?.rms;
      postStatus(
        "listening",
        rms != null ? `인식 없음 (rms ${rms})` : "인식 없음"
      );
      return;
    }

    rememberPrompt(text);
    // Sentence-level translation (not per audio chunk)
    feedSentenceBuffer(text);
    const device = result.device ? ` · ${result.device}` : "";
    postStatus("listening", `듣는 중${device}`);
  } catch (e) {
    console.warn("whisper chunk failed", e);
    postStatus("error", e?.message || String(e));
  }
}

async function chunkLoop() {
  if (chunkLoopRunning) return;
  chunkLoopRunning = true;

  // Pipeline: record next chunk while previous STT runs; never drop audio.
  let processPromise = Promise.resolve();

  while (isActive && tabStream) {
    try {
      const blob = await recordOneChunkWav(tabStream, chunkMs);
      mediaRecorder = null;
      if (!isActive) break;

      // Wait only if previous STT still in flight (no silent drop)
      await processPromise;
      if (!isActive) break;

      processPromise = processWhisperBlob(blob);
    } catch (e) {
      console.warn("record chunk failed", e);
      if (!isActive) break;
      postStatus("error", e?.message || String(e));
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  try {
    await processPromise;
  } catch {
    // ignore
  }
  chunkLoopRunning = false;
}

function stopChunkLoop() {
  if (recordTimer) {
    clearTimeout(recordTimer);
    recordTimer = null;
  }
  if (mediaRecorder && typeof mediaRecorder.stop === "function") {
    try {
      mediaRecorder.stop();
    } catch {
      // ignore
    }
  }
  mediaRecorder = null;
  chunkLoopRunning = false;
}

async function pingWhisper(baseUrl) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error("Whisper URL이 비어 있습니다.");
  if (!/^https?:\/\//i.test(base)) {
    throw new Error("URL은 http:// 또는 https:// 로 시작해야 합니다.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${base}/health`, {
      method: "GET",
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`health HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.ok) throw new Error(data?.load_error || "Whisper model not ready");
    return data;
  } catch (e) {
    if (e?.name === "AbortError") {
      throw new Error(
        `시간 초과: ${base} (방화벽/다른 Wi-Fi/IP 확인)`
      );
    }
    const msg = e?.message || String(e);
    if (/Failed to fetch|NetworkError/i.test(msg)) {
      throw new Error(
        `접속 불가: ${base} — Windows 방화벽(공용 프로필 포함), run.bat 0.0.0.0, 같은 LAN 여부를 확인하세요.`
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Web Speech fallback ----------

function createRecognition() {
  if (!SpeechRecognition) {
    throw new Error("Web Speech API를 지원하지 않습니다. Local Whisper를 사용하세요.");
  }
  const rec = new SpeechRecognition();
  rec.lang = sourceLang || "en-US";
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  rec.onstart = () => postStatus("listening", "마이크 듣는 중…");

  rec.onresult = (event) => {
    let interim = "";
    let finalText = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result[0]?.transcript || "";
      if (result.isFinal) finalText += transcript;
      else interim += transcript;
    }
    if (finalText.trim()) {
      lastInterimText = "";
      feedSentenceBuffer(finalText.trim());
    } else if (interim.trim()) {
      const now = Date.now();
      const text = interim.trim();
      if (text === lastInterimText && now - lastInterimSentAt < 400) return;
      if (now - lastInterimSentAt < 280 && text.startsWith(lastInterimText)) return;
      lastInterimText = text;
      lastInterimSentAt = now;
      enqueueTranslate(text, true);
    }
  };

  rec.onerror = (event) => {
    const err = event.error;
    if (err === "no-speech" || err === "aborted") return;
    if (err === "not-allowed") {
      postError("마이크 권한이 필요합니다.");
      isActive = false;
      return;
    }
    postStatus("error", err);
  };

  rec.onend = () => {
    if (isActive && sttEngine === "webspeech") {
      try {
        rec.start();
      } catch {
        setTimeout(() => {
          if (isActive && sttEngine === "webspeech") {
            try {
              rec.start();
            } catch {
              postError("음성 인식이 중단되었습니다.");
              isActive = false;
            }
          }
        }, 250);
      }
    } else {
      postStatus("stopped");
    }
  };

  return rec;
}

// ---------- start / stop ----------

async function start(opts = {}) {
  if (isActive) return { ok: true, already: true };

  sourceLang = opts.sourceLang || "en-US";
  sttEngine = opts.sttEngine === "webspeech" ? "webspeech" : "whisper";
  whisperBaseUrl = normalizeBaseUrl(opts.whisperUrl || "http://127.0.0.1:9000");
  // Default 5.5s — better for large-v3 + beam search on local-whisper
  chunkMs = Math.min(12000, Math.max(2500, Number(opts.chunkMs) || 5500));
  lastEnglishPrompt = "";
  resetSentenceBuffer();

  isActive = true;

  // Always try tab capture first (needed for Whisper; nice-to-have for mic)
  let tabOk = false;
  if (opts.streamId) {
    tabOk = await attachTabAudio(opts.streamId);
  }

  if (sttEngine === "whisper") {
    if (!tabOk) {
      isActive = false;
      return {
        ok: false,
        error:
          "탭 오디오를 캡처할 수 없습니다. 일반 웹 페이지 탭에서 다시 시도하세요.",
      };
    }
    try {
      postStatus("starting", "Whisper 연결 확인…");
      await pingWhisper(whisperBaseUrl);
    } catch (e) {
      isActive = false;
      stopTabAudio();
      return {
        ok: false,
        error: `Whisper 서버 연결 실패 (${whisperBaseUrl}): ${e?.message || e}`,
      };
    }
    postStatus("listening", "탭 오디오 → Whisper");
    chunkLoop(); // no await
    return { ok: true, mode: "whisper", whisperUrl: whisperBaseUrl };
  }

  // webspeech
  try {
    recognition = createRecognition();
    recognition.start();
    postStatus("starting", tabOk ? "tab+mic" : "mic");
    return { ok: true, mode: tabOk ? "tab+mic" : "mic" };
  } catch (e) {
    isActive = false;
    stopTabAudio();
    return { ok: false, error: e?.message || String(e) };
  }
}

function stop() {
  isActive = false;
  stopChunkLoop();
  flushSentenceBuffer("stop");
  lastEnglishPrompt = "";
  resetSentenceBuffer();
  if (recognition) {
    try {
      recognition.onend = null;
      recognition.stop();
    } catch {
      // ignore
    }
    recognition = null;
  }
  stopTabAudio();
  postStatus("stopped");
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "OFFSCREEN_PING") {
    sendResponse({ ok: true, ready: true });
    return false;
  }
  if (message?.type === "OFFSCREEN_START") {
    start({
      streamId: message.streamId,
      sourceLang: message.sourceLang,
      sttEngine: message.sttEngine,
      whisperUrl: message.whisperUrl,
      chunkMs: message.chunkMs,
    }).then(sendResponse);
    return true;
  }
  if (message?.type === "OFFSCREEN_STOP") {
    sendResponse(stop());
    return false;
  }
  if (message?.type === "OFFSCREEN_PING_WHISPER") {
    pingWhisper(message.whisperUrl || whisperBaseUrl)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) =>
        sendResponse({ ok: false, error: e?.message || String(e) })
      );
    return true;
  }
  return false;
});

chrome.runtime.sendMessage({ type: "OFFSCREEN_READY" }).catch(() => {});
