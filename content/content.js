/**
 * Content script: floating Korean subtitle overlay.
 * Keeps up to 3 finished sentences; sandwich menu adjusts size/position.
 */

(() => {
  if (window.__LIVE_KO_CAPTIONS_LOADED__) return;
  window.__LIVE_KO_CAPTIONS_LOADED__ = true;

  const ROOT_ID = "live-ko-captions-root";
  const MAX_SENTENCES = 3;
  const DEFAULT_FONT_SIZE = 18;
  const DEFAULT_WIDTH_PCT = 80;
  const DEFAULT_HEIGHT_VH = 10;
  const MIN_HEIGHT_VH = 10;
  const MAX_HEIGHT_VH = 55;
  const MIN_WIDTH_PCT = 40;
  const MAX_WIDTH_PCT = 100;

  let root = null;
  let panel = null;
  let linesEl = null;
  let originalEl = null;
  let statusEl = null;
  let dragHandle = null;
  let menuBtn = null;
  let layoutPanel = null;
  let isVisible = false;
  let layoutOpen = false;

  let settings = {
    fontSize: DEFAULT_FONT_SIZE,
    opacity: 0.5,
    position: "bottom", // bottom | top | custom
    panelWidthPct: DEFAULT_WIDTH_PCT,
    panelHeightVh: DEFAULT_HEIGHT_VH,
    panelLeft: null,
    panelTop: null,
  };

  /** @type {{ ko: string, en: string }[]} */
  let history = [];
  let interimKo = "";
  let interimEn = "";
  let fullscreenHooked = false;
  let saveTimer = null;

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function persistLayoutSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        chrome.storage.sync.set({
          position: settings.position,
          panelWidthPct: settings.panelWidthPct,
          panelHeightVh: settings.panelHeightVh,
          panelLeft: settings.panelLeft,
          panelTop: settings.panelTop,
          opacity: settings.opacity,
          fontSize: settings.fontSize,
        });
      } catch {
        // ignore
      }
    }, 200);
  }

  function applySettings() {
    if (!root || !panel) return;
    const alpha = clamp(Number(settings.opacity) || 0.5, 0.15, 0.95);
    const widthPct = clamp(
      Number(settings.panelWidthPct ?? DEFAULT_WIDTH_PCT),
      MIN_WIDTH_PCT,
      MAX_WIDTH_PCT
    );
    const heightVh = clamp(
      Number(settings.panelHeightVh ?? DEFAULT_HEIGHT_VH),
      MIN_HEIGHT_VH,
      MAX_HEIGHT_VH
    );
    settings.panelWidthPct = widthPct;
    settings.panelHeightVh = heightVh;

    root.style.setProperty("--lkc-font-size", `${settings.fontSize || DEFAULT_FONT_SIZE}px`);
    root.style.setProperty("--lkc-opacity", String(alpha));
    root.style.setProperty("--lkc-width", `${widthPct}vw`);
    root.style.setProperty("--lkc-body-h", `${heightVh}vh`);
    root.dataset.position = settings.position || "bottom";

    const body = root.querySelector(".lkc-body");
    // Stylesheet uses !important — override the same way
    panel.style.setProperty("width", `${widthPct}vw`, "important");
    panel.style.setProperty("max-width", `${widthPct}vw`, "important");
    if (body) {
      // Fixed height (not only max-height) so the slider always resizes the panel
      body.style.setProperty("height", `${heightVh}vh`, "important");
      body.style.setProperty("min-height", `${heightVh}vh`, "important");
      body.style.setProperty("max-height", `${heightVh}vh`, "important");
    }

    // Position (must override CSS !important or drag/snap will not stick)
    if (
      settings.position === "custom" &&
      settings.panelLeft != null &&
      settings.panelTop != null
    ) {
      setPanelBox(settings.panelLeft, settings.panelTop, true);
    } else if (settings.position === "top") {
      clearPanelBox();
      panel.style.setProperty("left", "50%", "important");
      panel.style.setProperty("top", "6%", "important");
      panel.style.setProperty("bottom", "auto", "important");
      panel.style.setProperty("transform", "translateX(-50%)", "important");
      // Keep snap preset; clear custom coords so next open stays top/bottom
      settings.panelLeft = null;
      settings.panelTop = null;
    } else {
      clearPanelBox();
      panel.style.setProperty("left", "50%", "important");
      panel.style.setProperty("top", "auto", "important");
      panel.style.setProperty("bottom", "6%", "important");
      panel.style.setProperty("transform", "translateX(-50%)", "important");
      settings.panelLeft = null;
      settings.panelTop = null;
      settings.position = "bottom";
    }

    syncLayoutControls();
  }

  function setPanelBox(left, top, custom) {
    if (!panel) return;
    panel.style.setProperty("left", `${Math.round(left)}px`, "important");
    panel.style.setProperty("top", `${Math.round(top)}px`, "important");
    panel.style.setProperty("bottom", "auto", "important");
    panel.style.setProperty("transform", "none", "important");
    if (custom) {
      settings.position = "custom";
      settings.panelLeft = Math.round(left);
      settings.panelTop = Math.round(top);
      if (root) root.dataset.position = "custom";
    }
  }

  function clearPanelBox() {
    // no-op reserved; values always set via setProperty
  }

  function syncLayoutControls() {
    if (!layoutPanel) return;
    const w = layoutPanel.querySelector(".lkc-ctrl-width");
    const h = layoutPanel.querySelector(".lkc-ctrl-height");
    const p = layoutPanel.querySelector(".lkc-ctrl-pos");
    const wVal = layoutPanel.querySelector(".lkc-ctrl-width-val");
    const hVal = layoutPanel.querySelector(".lkc-ctrl-height-val");
    const wp = clamp(
      settings.panelWidthPct ?? DEFAULT_WIDTH_PCT,
      MIN_WIDTH_PCT,
      MAX_WIDTH_PCT
    );
    const hp = clamp(
      settings.panelHeightVh ?? DEFAULT_HEIGHT_VH,
      MIN_HEIGHT_VH,
      MAX_HEIGHT_VH
    );
    if (w) w.value = String(wp);
    if (h) h.value = String(hp);
    if (p) {
      p.value =
        settings.position === "top"
          ? "top"
          : settings.position === "custom"
            ? "custom"
            : "bottom";
    }
    if (wVal) wVal.textContent = `${wp}%`;
    if (hVal) hVal.textContent = `${hp}vh`;
  }

  function getFullscreenElement() {
    return (
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement ||
      null
    );
  }

  function mountOverlayHost() {
    if (!root) return;
    const fs = getFullscreenElement();
    const host = fs || document.documentElement;
    if (root.parentNode !== host) {
      try {
        host.appendChild(root);
      } catch (e) {
        console.warn("[captions] mount host failed", e);
        document.documentElement.appendChild(root);
      }
    }
    root.classList.toggle("lkc-in-fullscreen", !!fs);
  }

  function hookFullscreen() {
    if (fullscreenHooked) return;
    fullscreenHooked = true;
    const onFs = () => {
      if (!root) return;
      mountOverlayHost();
    };
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("webkitfullscreenchange", onFs);
    document.addEventListener("mozfullscreenchange", onFs);
    document.addEventListener("MSFullscreenChange", onFs);
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
      const age = history.length - 1 - i;
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

    if (originalEl) {
      const enLines = history.map((h) => h.en).filter(Boolean);
      if (interimEn) enLines.push(interimEn);
      originalEl.textContent = enLines.slice(-MAX_SENTENCES).join("\n");
    }

    const scrollBox = root?.querySelector(".lkc-body");
    if (scrollBox) {
      scrollBox.scrollTop = scrollBox.scrollHeight;
    }
  }

  function setLayoutOpen(open) {
    layoutOpen = !!open;
    if (layoutPanel) {
      layoutPanel.hidden = !layoutOpen;
    }
    if (menuBtn) {
      menuBtn.classList.toggle("active", layoutOpen);
    }
  }

  function setupLayoutPanel() {
    layoutPanel = root.querySelector(".lkc-layout");
    menuBtn = root.querySelector(".lkc-menu");
    if (!layoutPanel || !menuBtn) return;

    menuBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setLayoutOpen(!layoutOpen);
      if (layoutOpen) syncLayoutControls();
    });

    layoutPanel.addEventListener("click", (e) => e.stopPropagation());
    layoutPanel.addEventListener("mousedown", (e) => e.stopPropagation());

    const w = layoutPanel.querySelector(".lkc-ctrl-width");
    const h = layoutPanel.querySelector(".lkc-ctrl-height");
    const p = layoutPanel.querySelector(".lkc-ctrl-pos");
    const resetBtn = layoutPanel.querySelector(".lkc-ctrl-reset");

    w?.addEventListener("input", () => {
      settings.panelWidthPct = clamp(Number(w.value), MIN_WIDTH_PCT, MAX_WIDTH_PCT);
      applySettings();
      persistLayoutSettings();
    });

    h?.addEventListener("input", () => {
      settings.panelHeightVh = clamp(Number(h.value), MIN_HEIGHT_VH, MAX_HEIGHT_VH);
      applySettings();
      persistLayoutSettings();
    });

    p?.addEventListener("change", () => {
      const v = p.value;
      if (v === "custom") {
        // Keep current pixel position if already custom; else convert from rect
        const rect = panel.getBoundingClientRect();
        settings.position = "custom";
        settings.panelLeft = Math.round(rect.left);
        settings.panelTop = Math.round(rect.top);
      } else {
        settings.position = v === "top" ? "top" : "bottom";
        settings.panelLeft = null;
        settings.panelTop = null;
      }
      applySettings();
      persistLayoutSettings();
    });

    resetBtn?.addEventListener("click", () => {
      settings.panelWidthPct = DEFAULT_WIDTH_PCT;
      settings.panelHeightVh = DEFAULT_HEIGHT_VH;
      settings.position = "bottom";
      settings.panelLeft = null;
      settings.panelTop = null;
      applySettings();
      persistLayoutSettings();
      setLayoutOpen(false);
    });
  }

  function ensureOverlay() {
    if (root && document.contains(root)) {
      mountOverlayHost();
      return root;
    }

    root = document.getElementById(ROOT_ID) || document.createElement("div");
    root.id = ROOT_ID;
    root.setAttribute("data-live-ko-captions", "1");
    root.innerHTML = `
      <div class="lkc-panel" role="region" aria-label="실시간 한글 자막">
        <div class="lkc-toolbar">
          <button type="button" class="lkc-btn lkc-drag" title="드래그하여 이동" aria-label="이동">⠿</button>
          <button type="button" class="lkc-btn lkc-menu" title="크기·위치 조절">☰</button>
          <span class="lkc-status" data-status="idle">대기</span>
          <button type="button" class="lkc-btn lkc-toggle-orig" title="원문 표시/숨김">EN</button>
          <button type="button" class="lkc-btn lkc-close" title="자막 닫기">×</button>
        </div>
        <div class="lkc-layout" hidden>
          <div class="lkc-ctrl-row">
            <span>폭 <em class="lkc-ctrl-width-val">${DEFAULT_WIDTH_PCT}%</em></span>
            <input class="lkc-ctrl-width" type="range" min="${MIN_WIDTH_PCT}" max="${MAX_WIDTH_PCT}" step="5" value="${DEFAULT_WIDTH_PCT}" />
          </div>
          <div class="lkc-ctrl-row">
            <span>높이 <em class="lkc-ctrl-height-val">${DEFAULT_HEIGHT_VH}vh</em></span>
            <input class="lkc-ctrl-height" type="range" min="${MIN_HEIGHT_VH}" max="${MAX_HEIGHT_VH}" step="1" value="${DEFAULT_HEIGHT_VH}" />
          </div>
          <div class="lkc-ctrl-row lkc-ctrl-row-pos">
            <select class="lkc-ctrl-pos">
              <option value="bottom">하단</option>
              <option value="top">상단</option>
              <option value="custom">드래그 위치</option>
            </select>
            <button type="button" class="lkc-btn lkc-ctrl-reset" title="기본값">↺</button>
          </div>
        </div>
        <div class="lkc-body">
          <div class="lkc-text" aria-live="polite">
            <div class="lkc-lines"></div>
          </div>
          <div class="lkc-original" hidden></div>
        </div>
      </div>
    `;

    panel = root.querySelector(".lkc-panel");
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

    hookFullscreen();
    setupLayoutPanel();
    setupDrag();
    applySettings();
    mountOverlayHost();
    return root;
  }

  function setupDrag() {
    if (!panel || !dragHandle) return;
    if (dragHandle.dataset.lkcDragBound === "1") return;
    dragHandle.dataset.lkcDragBound = "1";

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;
    let pointerId = null;

    const onMove = (e) => {
      if (!dragging) return;
      if (pointerId != null && e.pointerId !== pointerId) return;
      e.preventDefault();
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      setPanelBox(origLeft + dx, origTop + dy, true);
      syncLayoutControls();
    };

    const onUp = (e) => {
      if (!dragging) return;
      if (pointerId != null && e.pointerId !== pointerId) return;
      dragging = false;
      try {
        if (pointerId != null) dragHandle.releasePointerCapture(pointerId);
      } catch {
        // ignore
      }
      pointerId = null;
      dragHandle.classList.remove("lkc-dragging");
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      persistLayoutSettings();
    };

    dragHandle.addEventListener("pointerdown", (e) => {
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      setLayoutOpen(false);

      const rect = panel.getBoundingClientRect();
      dragging = true;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      origLeft = rect.left;
      origTop = rect.top;
      setPanelBox(rect.left, rect.top, true);
      dragHandle.classList.add("lkc-dragging");

      try {
        dragHandle.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }

      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onUp, true);
    });
  }

  function mergeLayoutFrom(source = {}) {
    if (source.fontSize != null) settings.fontSize = source.fontSize;
    if (source.opacity != null) settings.opacity = source.opacity;
    if (source.position != null) settings.position = source.position;
    if (source.panelWidthPct != null) {
      settings.panelWidthPct = clamp(
        Number(source.panelWidthPct),
        MIN_WIDTH_PCT,
        MAX_WIDTH_PCT
      );
    }
    if (source.panelHeightVh != null) {
      settings.panelHeightVh = clamp(
        Number(source.panelHeightVh),
        MIN_HEIGHT_VH,
        MAX_HEIGHT_VH
      );
    }
    if ("panelLeft" in source) settings.panelLeft = source.panelLeft;
    if ("panelTop" in source) settings.panelTop = source.panelTop;

    if (settings.fontSize == null) settings.fontSize = DEFAULT_FONT_SIZE;
    if (settings.opacity == null) settings.opacity = 0.5;
    if (settings.panelWidthPct == null) settings.panelWidthPct = DEFAULT_WIDTH_PCT;
    if (settings.panelHeightVh == null) settings.panelHeightVh = DEFAULT_HEIGHT_VH;
    if (!settings.position) settings.position = "bottom";
  }

  function showOverlay(nextSettings = {}) {
    // Apply saved layout (width / height / position) from start payload
    mergeLayoutFrom(nextSettings);

    ensureOverlay();
    applySettings();
    mountOverlayHost();
    clearCaptions();
    setLayoutOpen(false);
    root.classList.add("lkc-visible");
    isVisible = true;
    setStatus("ready", "준비됨");
  }

  /** Load last layout from storage so next open restores width/height/position. */
  function loadPersistedLayout() {
    try {
      chrome.storage.sync.get(
        {
          fontSize: DEFAULT_FONT_SIZE,
          opacity: 0.5,
          position: "bottom",
          panelWidthPct: DEFAULT_WIDTH_PCT,
          panelHeightVh: DEFAULT_HEIGHT_VH,
          panelLeft: null,
          panelTop: null,
        },
        (stored) => {
          if (chrome.runtime?.lastError) return;
          mergeLayoutFrom(stored || {});
          if (root && panel) applySettings();
        }
      );
    } catch {
      // ignore
    }
  }

  function hideOverlay() {
    if (root) {
      root.classList.remove("lkc-visible");
      setLayoutOpen(false);
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
    mountOverlayHost();
    if (!isVisible) {
      root.classList.add("lkc-visible");
      isVisible = true;
    }

    const ko = (text || "").trim();
    const en = (original || text || "").trim();

    if (interim) {
      interimKo = ko && ko !== lastHistoryKo() ? ko : "";
      interimEn = en || ko;
      if (ko && history.some((h) => h.ko === ko) && en && en !== ko) {
        interimKo = "";
        interimEn = en;
      }
      renderLines();
      return;
    }

    interimKo = "";
    interimEn = "";
    if (!ko && !en) {
      renderLines();
      return;
    }

    const entry = { ko: ko || en, en: en || ko };
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

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync" && area !== "local") return;
      const patch = {};
      if (changes.opacity) patch.opacity = changes.opacity.newValue;
      if (changes.fontSize) patch.fontSize = changes.fontSize.newValue;
      if (changes.panelWidthPct) patch.panelWidthPct = changes.panelWidthPct.newValue;
      if (changes.panelHeightVh) patch.panelHeightVh = changes.panelHeightVh.newValue;
      if (changes.position) patch.position = changes.position.newValue;
      if (changes.panelLeft) patch.panelLeft = changes.panelLeft.newValue;
      if (changes.panelTop) patch.panelTop = changes.panelTop.newValue;
      if (Object.keys(patch).length) {
        mergeLayoutFrom(patch);
        applySettings();
      }
    });
  } catch {
    // ignore
  }

  // Restore last width / height / position as soon as the content script loads
  loadPersistedLayout();

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
