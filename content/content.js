/**
 * Content script: floating Korean subtitle overlay.
 * Keeps up to 3 finished sentences visible so short lines don't wipe long ones.
 */

(() => {
  if (window.__LIVE_KO_CAPTIONS_LOADED__) return;
  window.__LIVE_KO_CAPTIONS_LOADED__ = true;

  const ROOT_ID = "live-ko-captions-root";
  const MAX_SENTENCES = 3;
  // 22px * 0.8 ≈ 18
  const DEFAULT_FONT_SIZE = 18;

  let root = null;
  let linesEl = null;
  let originalEl = null;
  let statusEl = null;
  let dragHandle = null;
  let isVisible = false;
  let settings = {
    fontSize: DEFAULT_FONT_SIZE,
    opacity: 0.85,
    position: "bottom",
  };

  /** @type {{ ko: string, en: string }[]} */
  let history = [];
  let interimKo = "";
  let interimEn = "";

  function applySettings() {
    if (!root) return;
    root.style.setProperty("--lkc-font-size", `${settings.fontSize}px`);
    root.style.setProperty("--lkc-opacity", String(settings.opacity));
    root.dataset.position = settings.position || "bottom";
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function clearCaptions() {
    history = [];
    interimKo = "";
    interimEn = "";
    if (linesEl) linesEl.innerHTML = "";
    if (originalEl) originalEl.textContent = "";
  }

  function renderLines() {
    if (!linesEl) return;

    const parts = [];
    history.forEach((item, i) => {
      const age = history.length - 1 - i; // 0 = newest final
      const cls =
        age === 0
          ? "lkc-line lkc-line-current"
          : age === 1
            ? "lkc-line lkc-line-prev"
            : "lkc-line lkc-line-older";
      parts.push(`<div class="${cls}">${escapeHtml(item.ko)}</div>`);
    });

    if (interimKo || interimEn) {
      const t = interimKo || interimEn;
      parts.push(
        `<div class="lkc-line lkc-line-interim">${escapeHtml(t)}</div>`
      );
    }

    linesEl.innerHTML = parts.join("");

    // EN panel: up to 3 finished + interim
    if (originalEl) {
      const enLines = history.map((h) => h.en).filter(Boolean);
      if (interimEn) enLines.push(interimEn);
      originalEl.textContent = enLines.slice(-MAX_SENTENCES).join("\n");
    }

    // Auto-scroll to bottom so newest is visible
    const scrollBox = root?.querySelector(".lkc-body");
    if (scrollBox) {
      scrollBox.scrollTop = scrollBox.scrollHeight;
    }
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
        <div class="lkc-body">
          <div class="lkc-text" aria-live="polite">
            <div class="lkc-lines"></div>
          </div>
          <div class="lkc-original" hidden></div>
        </div>
      </div>
    `;

    document.documentElement.appendChild(root);

    linesEl = root.querySelector(".lkc-lines");
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
    if (settings.fontSize == null) settings.fontSize = DEFAULT_FONT_SIZE;
    ensureOverlay();
    applySettings();
    clearCaptions();
    root.classList.add("lkc-visible");
    isVisible = true;
    setStatus("ready", "준비됨");
  }

  function hideOverlay() {
    if (root) {
      root.classList.remove("lkc-visible");
      clearCaptions();
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

    const ko = (text || "").trim();
    const en = (original || text || "").trim();

    if (interim) {
      // Unfinished sentence: keep history, show partial at bottom
      interimKo = ko && ko !== lastHistoryKo() ? ko : "";
      // Prefer English partial when still buffering
      interimEn = en || ko;
      // If offscreen sent last finished KO as `text` with interim flag, don't duplicate as interim line in Korean
      if (ko && history.some((h) => h.ko === ko) && en && en !== ko) {
        interimKo = "";
        interimEn = en;
      }
      renderLines();
      return;
    }

    // Final sentence
    interimKo = "";
    interimEn = "";
    if (!ko && !en) {
      renderLines();
      return;
    }

    const entry = { ko: ko || en, en: en || ko };
    // Avoid consecutive duplicates
    const last = history[history.length - 1];
    if (!last || last.ko !== entry.ko || last.en !== entry.en) {
      history.push(entry);
      while (history.length > MAX_SENTENCES) history.shift();
    }
    renderLines();
  }

  function lastHistoryKo() {
    return history.length ? history[history.length - 1].ko : "";
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
        if (linesEl) {
          linesEl.innerHTML = `<div class="lkc-line lkc-line-interim">${escapeHtml(
            message.error || "오류가 발생했습니다."
          )}</div>`;
        }
        sendResponse?.({ ok: true });
        break;
      default:
        break;
    }
    return false;
  });
})();
