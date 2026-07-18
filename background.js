/**
 * Service worker: orchestrates offscreen STT + tab messaging.
 */

const OFFSCREEN_URL = "offscreen/offscreen.html";
const OFFSCREEN_REASONS = ["USER_MEDIA", "AUDIO_PLAYBACK"];
const OFFSCREEN_JUSTIFICATION =
  "Capture tab audio and run speech recognition / Whisper for live captions.";

let activeTabId = null;
let isRunning = false;

async function waitForOffscreenReady(timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await chrome.runtime.sendMessage({ type: "OFFSCREEN_PING" });
      if (res?.ready) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  return false;
}

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument?.();
  if (!existing) {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: OFFSCREEN_REASONS,
        justification: OFFSCREEN_JUSTIFICATION,
      });
    } catch (err) {
      if (!String(err?.message || err).includes("Only a single offscreen")) {
        throw err;
      }
    }
  }

  const ready = await waitForOffscreenReady();
  if (!ready) {
    throw new Error("오프스크린 문서를 준비하지 못했습니다.");
  }
}

async function closeOffscreen() {
  try {
    const existing = await chrome.offscreen.hasDocument?.();
    if (existing === false) return;
    await chrome.offscreen.closeDocument();
  } catch {
    // ignore
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content/content.js"],
      });
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ["content/content.css"],
      });
      await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
      console.warn("Failed to message tab", tabId, e);
    }
  }
}

async function startCaptions(tabId, settings = {}) {
  if (isRunning && activeTabId === tabId) {
    return { ok: true, alreadyRunning: true };
  }

  if (isRunning && activeTabId != null && activeTabId !== tabId) {
    await stopCaptions();
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (
    !tab?.url ||
    tab.url.startsWith("chrome://") ||
    tab.url.startsWith("chrome-extension://") ||
    tab.url.startsWith("edge://") ||
    tab.url.startsWith("about:")
  ) {
    return { ok: false, error: "이 페이지에서는 자막을 사용할 수 없습니다." };
  }

  await ensureOffscreen();

  let streamId = null;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (e) {
    console.warn("tabCapture unavailable", e);
  }

  const stored = await chrome.storage.sync.get({
    sourceLang: "en-US",
    fontSize: 22,
    opacity: 0.85,
    position: "bottom",
    sttEngine: "whisper",
    whisperUrl: "http://192.168.2.247:9000",
    chunkMs: 5500,
  });

  const config = { ...stored, ...settings };

  await sendToTab(tabId, {
    type: "CAPTIONS_START",
    settings: config,
  });

  const response = await chrome.runtime.sendMessage({
    type: "OFFSCREEN_START",
    streamId,
    sourceLang: config.sourceLang || "en-US",
    sttEngine: config.sttEngine || "whisper",
    whisperUrl: config.whisperUrl || "http://127.0.0.1:9000",
    chunkMs: config.chunkMs || 5500,
    targetLang: "ko",
  });

  if (!response?.ok) {
    await sendToTab(tabId, { type: "CAPTIONS_STOP" });
    return {
      ok: false,
      error: response?.error || "음성 인식을 시작할 수 없습니다.",
    };
  }

  activeTabId = tabId;
  isRunning = true;
  await chrome.storage.session.set({ isRunning: true, activeTabId: tabId });
  await chrome.action.setBadgeText({ text: "ON", tabId });
  await chrome.action.setBadgeBackgroundColor({ color: "#22c55e", tabId });

  return {
    ok: true,
    mode: response.mode || config.sttEngine || "whisper",
    whisperUrl: response.whisperUrl || config.whisperUrl,
  };
}

async function stopCaptions() {
  const tabId = activeTabId;

  try {
    await chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP" });
  } catch {
    // offscreen may already be gone
  }

  await closeOffscreen();

  if (tabId != null) {
    await sendToTab(tabId, { type: "CAPTIONS_STOP" });
    try {
      await chrome.action.setBadgeText({ text: "", tabId });
    } catch {
      // tab closed
    }
  }

  activeTabId = null;
  isRunning = false;
  await chrome.storage.session.set({ isRunning: false, activeTabId: null });
  return { ok: true };
}

async function getStatus() {
  return { isRunning, activeTabId };
}

async function testWhisper(whisperUrl) {
  await ensureOffscreen();
  try {
    const res = await chrome.runtime.sendMessage({
      type: "OFFSCREEN_PING_WHISPER",
      whisperUrl,
    });
    return res || { ok: false, error: "응답 없음" };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handle = async () => {
    switch (message?.type) {
      case "START_CAPTIONS": {
        let tabId = message.tabId;
        if (tabId == null) {
          const tab = await getActiveTab();
          tabId = tab?.id;
        }
        if (tabId == null) {
          return { ok: false, error: "활성 탭을 찾을 수 없습니다." };
        }
        return startCaptions(tabId, message.settings || {});
      }
      case "STOP_CAPTIONS":
        return stopCaptions();
      case "GET_STATUS":
        return getStatus();
      case "TEST_WHISPER":
        return testWhisper(message.whisperUrl);
      case "CAPTION_RESULT": {
        if (activeTabId != null) {
          await sendToTab(activeTabId, {
            type: "CAPTION_UPDATE",
            text: message.text,
            original: message.original,
            interim: !!message.interim,
          });
        }
        return { ok: true };
      }
      case "CAPTION_STATUS": {
        if (activeTabId != null) {
          await sendToTab(activeTabId, {
            type: "CAPTION_STATUS",
            status: message.status,
            detail: message.detail,
          });
        }
        return { ok: true };
      }
      case "CAPTION_ERROR": {
        if (activeTabId != null) {
          await sendToTab(activeTabId, {
            type: "CAPTION_ERROR",
            error: message.error,
          });
        }
        return { ok: true };
      }
      case "OFFSCREEN_READY":
      case "OFFSCREEN_PING":
        return null;
      default:
        return null;
    }
  };

  handle().then(sendResponse);
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === activeTabId) {
    await stopCaptions();
  }
});

chrome.storage.session.get({ isRunning: false, activeTabId: null }).then((s) => {
  if (s.isRunning) {
    chrome.storage.session.set({ isRunning: false, activeTabId: null });
  }
});
