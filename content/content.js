/**
 * Content script: floating Korean subtitle overlay.
 */

(() => {
  if (window.__LIVE_KO_CAPTIONS_LOADED__) return;
  window.__LIVE_KO_CAPTIONS_LOADED__ = true;

  const ROOT_ID = "live-ko-captions-root";
  let root = null;
  let textEl = null;
  let originalEl = null;
  let statusEl = null;
  let dragHandle = null;
  let isVisible = false;
  let settings = {
    fontSize: 22,
    opacity: 0.85,
    position: "bottom",
  };

  function applySettings() {
    if (!root) return;
    root.style.setProperty("--lkc-font-size", `${settings.fontSize}px`);
    root.style.setProperty("--lkc-opacity", String(settings.opacity));
    root.dataset.position = settings.position || "bottom";
  }

  function ensureOverlay() {
    if (root && document.documentElement.contains(root)) return root;

    root = document.createElement("div");
    root.id = ROOT_ID;
    root.setAttribute("data-live-ko-captions", "1");
    root.innerHTML = `
      <div class="lkc-panel" role="region" aria-label="실시간 한글 자막">
        <div class="lkc-toolbar">
          <span class="lkc-drag" title="드래그하여 이동">⋮⋮</span>
          <span class="lkc-status" data-status="idle">대기</span>
          <button type="button" class="lkc-btn lkc-toggle-orig" title="원문 표시/숨김">EN</button>
          <button type="button" class="lkc-btn lkc-close" title="자막 닫기">×</button>
        </div>
        <div class="lkc-text" aria-live="polite"></div>
        <div class="lkc-original" hidden></div>
      </div>
    `;

    // Attach to documentElement to survive some SPA body replacements
    document.documentElement.appendChild(root);

    textEl = root.querySelector(".lkc-text");
    originalEl = root.querySelector(".lkc-original");
    statusEl = root.querySelector(".lkc-status");
    dragHandle = root.querySelector(".lkc-drag");

    root.querySelector(".lkc-close").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "STOP_CAPTIONS" }).catch(() => {});
      hideOverlay();
    });

    root.querySelector(".lkc-toggle-orig").addEventListener("click", (e) => {
      const btn = e.currentTarget;
      const show = originalEl.hasAttribute("hidden");
      if (show) {
        originalEl.removeAttribute("hidden");
        btn.classList.add("active");
      } else {
        originalEl.setAttribute("hidden", "");
        btn.classList.remove("active");
      }
    });

    setupDrag();
    applySettings();
    return root;
  }

  function setupDrag() {
    const panel = root.querySelector(".lkc-panel");
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;

    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      panel.style.left = `${origLeft + dx}px`;
      panel.style.top = `${origTop + dy}px`;
      panel.style.bottom = "auto";
      panel.style.transform = "none";
      root.dataset.position = "custom";
    };

    const onUp = () => {
      dragging = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    dragHandle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      dragging = true;
      const rect = panel.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      origLeft = rect.left;
      origTop = rect.top;
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.bottom = "auto";
      panel.style.transform = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  function showOverlay(nextSettings = {}) {
    settings = { ...settings, ...nextSettings };
    ensureOverlay();
    applySettings();
    root.classList.add("lkc-visible");
    isVisible = true;
    setStatus("ready", "준비됨");
  }

  function hideOverlay() {
    if (root) {
      root.classList.remove("lkc-visible");
      if (textEl) textEl.textContent = "";
      if (originalEl) originalEl.textContent = "";
    }
    isVisible = false;
  }

  function setStatus(status, label) {
    if (!statusEl) return;
    statusEl.dataset.status = status;
    statusEl.textContent = label || status;
  }

  function updateCaption({ text, original, interim }) {
    ensureOverlay();
    if (!isVisible) {
      root.classList.add("lkc-visible");
      isVisible = true;
    }
    textEl.textContent = text || "";
    textEl.classList.toggle("lkc-interim", !!interim);
    if (original) {
      originalEl.textContent = original;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case "CAPTIONS_START":
        showOverlay(message.settings || {});
        sendResponse?.({ ok: true });
        break;
      case "CAPTIONS_STOP":
        hideOverlay();
        sendResponse?.({ ok: true });
        break;
      case "CAPTION_UPDATE":
        updateCaption(message);
        sendResponse?.({ ok: true });
        break;
      case "CAPTION_STATUS": {
        const map = {
          starting: "시작 중…",
          listening: "듣는 중",
          stopped: "중지됨",
          error: "오류",
        };
        setStatus(
          message.status,
          message.detail || map[message.status] || message.status
        );
        sendResponse?.({ ok: true });
        break;
      }
      case "CAPTION_ERROR":
        setStatus("error", message.error || "오류");
        if (textEl) {
          textEl.textContent = message.error || "오류가 발생했습니다.";
          textEl.classList.add("lkc-interim");
        }
        sendResponse?.({ ok: true });
        break;
      default:
        break;
    }
    return false;
  });
})();
