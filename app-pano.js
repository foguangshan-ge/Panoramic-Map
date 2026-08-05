/**
 * app-pano.js — V3 互動空間地圖主程式（360 全景版）
 *
 * 跟 V2 的 app.js 比，換掉的只有「場景怎麼畫、光點怎麼定位」這一塊：
 *   - 場景渲染／場景間跳轉／滑鼠拖曳縮放／陀螺儀 → 全部交給 Pannellum，
 *     不用再自己算 object-fit:cover 裁切、也不用自己寫左右拖曳手勢。
 *     這是「V2 手機展開不好」這件事的根本解法：以前是拿平面照片硬凹
 *     假 3D（裁切＋左右平移），手機直向螢幕裁得多、比例對不上；現在
 *     是真的全景球體貼圖，容器多高多寬 Pannellum 自己重新算視角，
 *     直向、橫向、任何尺寸都是同一份資料、同一個體驗。
 *   - 光點座標從畫面 x/y 百分比 → 球面 yaw/pitch 角度，跟螢幕比例無關，
 *     標一次到處通用。
 *   - 語言／音檔／側邊目錄／資訊卡／圖片放大 Modal 這些跟「畫面裡是
 *     平面照片還是全景」無關的部分，原封不動沿用 V2 的邏輯。
 */

const SHOW_DEBUG_HUD = false;

// 網址加 ?debug=1 開啟「點一下印出 pitch/yaw」的座標校正模式，
// 取代舊版「螢幕截圖＋標紅點」的標註流程
const PANO_DEBUG = new URLSearchParams(location.search).get("debug") === "1";
if (PANO_DEBUG) document.body.classList.add("pano-debug");

// ============================================================
// 語言切換（原封不動沿用 V2）
// ============================================================
const LANG_ORDER = ["fr", "en", "zh"];
const LANG_SHORT_LABEL = { fr: "FR", en: "EN", zh: "中文" };

let CURRENT_LANG = localStorage.getItem("fgs_lang") || "fr";
if (!LANG_ORDER.includes(CURRENT_LANG)) CURRENT_LANG = "fr";

function setLang(lang) {
  CURRENT_LANG = lang;
  localStorage.setItem("fgs_lang", lang);
}

function tItem(item, field) {
  if (CURRENT_LANG === "zh" && item[field + "_zh"]) return item[field + "_zh"];
  if (CURRENT_LANG === "en" && item[field + "_en"]) return item[field + "_en"];
  return item[field];
}

const UI_STRINGS = {
  sommaireToggle: { fr: "☰ Sommaire", en: "☰ Menu", zh: "☰ 目錄" },
  sommaireToggleLabel: { fr: "Ouvrir le sommaire de la visite", en: "Open the tour menu", zh: "開啟導覽目錄" },
  backBtn: { fr: "↓ Précédent", en: "↓ Back", zh: "↓ 上一步" },
  backBtnLabel: { fr: "Précédent", en: "Back", zh: "上一步" },
  viewLabel: { fr: "Voir : ", en: "View: ", zh: "查看：" },
  gyroLabel: { fr: "Activer le gyroscope", en: "Enable gyroscope", zh: "開啟陀螺儀控制" },
};
function tUi(key) {
  return UI_STRINGS[key][CURRENT_LANG] || UI_STRINGS[key].fr;
}

const AREA_LABELS = {
  "Entrée et parvis": { fr: "Entrée et parvis", en: "Entrance and Forecourt", zh: "入口與前庭" },
  "Grande salle du Bouddha": { fr: "Grande salle du Bouddha", en: "Great Buddha Hall", zh: "大雄寶殿" },
  "Salle de Ksitigarbha": { fr: "Salle de Ksitigarbha", en: "Ksitigarbha Hall", zh: "地藏殿" },
};
function tArea(area) {
  const entry = AREA_LABELS[area];
  if (!entry) return area;
  return entry[CURRENT_LANG] || entry.fr;
}

function debugLog(msg) {
  console.log(msg);
  if (!SHOW_DEBUG_HUD) return;
  let hud = document.getElementById("debug-hud");
  if (!hud) {
    hud = document.createElement("div");
    hud.id = "debug-hud";
    hud.style.cssText =
      "position:fixed;left:0;bottom:0;z-index:9999;background:rgba(0,0,0,0.75);color:#0f0;" +
      "font:12px monospace;padding:8px 10px;max-width:60vw;max-height:45vh;overflow-y:auto;" +
      "white-space:pre-wrap;pointer-events:none;";
    document.body.appendChild(hud);
  }
  const line = document.createElement("div");
  line.textContent = new Date().toLocaleTimeString() + "  " + msg;
  hud.appendChild(line);
  while (hud.childNodes.length > 20) hud.removeChild(hud.firstChild);
}

// ============================================================
// el() — 沿用 V1/V2 的小工具
// ============================================================
function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach((key) => {
      if (key === "class") node.className = attrs[key];
      else if (key.startsWith("on") && typeof attrs[key] === "function") {
        node.addEventListener(key.slice(2), attrs[key]);
      } else {
        node.setAttribute(key, attrs[key]);
      }
    });
  }
  (children || []).forEach((child) => {
    if (child == null) return;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  });
  return node;
}

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m + ":" + String(s).padStart(2, "0");
}

// ============================================================
// PanoEngine — 用 Pannellum 取代 V2 的 SceneEngine + SceneStage
// ============================================================
class PanoEngine {
  constructor(containerId, onHotspotClick) {
    this.containerId = containerId;
    this.onHotspotClick = onHotspotClick;
    this.viewer = null;
    this.history = []; // 走過的場景 id，goBack() 用
    this.currentSceneId = null;
    this._suppressHistoryPush = false; // 內部觸發（reset / 上一步 / 換語言重繪）不要重複推入歷史
    this._isRelabeling = false;
    this._relabelPending = false;
    this._relabelToken = 0;
    this._listeners = {};
  }
  on(evt, fn) { (this._listeners[evt] ??= []).push(fn); }
  _emit(evt, payload) { (this._listeners[evt] || []).forEach((fn) => fn(payload)); }
  canGoBack() { return this.history.length > 0; }

  /** 依照 scenes-pano.js 的 SCENES 陣列，組出 Pannellum 要的 config 物件 */
  _buildConfig() {
    const scenes = {};
    SCENES.forEach((s) => {
      const hotSpots = [];
      s.hotspots.forEach((h) => hotSpots.push(this._tourItemHotspot(h)));
      // 出口（advance／branch）全部不放 3D 浮動光點了，統一在畫面下方用固定按鈕列（見
      // index.html #nav-bar）。原本 branch 用 Pannellum 內建 type:"scene" 光點時，畫面上
      // 會多出一條跟按鈕文字無關的長條色塊（Pannellum 自己的 .pnlm-hotspot 預設樣式跟我們
      // 疊在一起造成的），拿掉 3D 光點後這個問題連帶消失。導覽項目的光點（.hotspot）維持
      // 在球面上，因為那些點本來就該對應畫面裡實際的物件位置。
      scenes[s.id] = {
        title: tItem(s, "label"),
        type: "equirectangular",
        panorama: s.image,
        hfov: s.hfov || 100,
        minHfov: 50,
        maxHfov: 120,
        pitch: s.pitch || 0,
        yaw: s.yaw || 0,
        horizonPitch: s.horizonPitch || 0,
        horizonRoll: s.horizonRoll || 0,
        hotSpots,
      };
    });
    return {
      default: {
        firstScene: ENTRY_SCENE_ID,
        sceneFadeDuration: 900,
        // autoLoad 關掉：原本 true 的時候，Pannellum 一建立 viewer 就會自己先載入 firstScene，
        // 而 relabel() 建好 viewer 後緊接著又會自己呼叫 loadScene() 把畫面轉回「使用者當下
        // 真正在看的場景」——這兩個載入幾乎同時發生，等於同一輪重建裡自己打自己：Pannellum
        // 內部負責讀圖的 FileReader 流程被自己緊接著發出的第二個載入指令攔腰打斷，稍後那個
        // 回呼再想寫入就會炸「Cannot set properties of undefined (setting 'src')」。跟前兩次
        // 修的「連點」「計時器」都無關，是 relabel() 這個函式本身每次呼叫都必定會自己觸發兩次
        // 載入——不管手速多慢、點幾下都會發生，因為問題出在單一次呼叫裡面，不是呼叫跟呼叫之間。
        // 關掉 autoLoad 後，載入永遠只交給我們自己明確呼叫的那一次 loadScene()（enter() 跟
        // relabel() 各自呼叫一次），不會有兩個載入互相搶。
        autoLoad: false,
        showControls: false,
        compass: false,
        hotSpotDebug: false, // Pannellum 內建的紅點除錯圖層不開，用下面自己做的 PANO_DEBUG 取代
        draggable: true,
        mouseZoom: true,
      },
      scenes,
    };
  }

  /** 導覽項目光點（原本 renderHotspot()）：type 留空＝自訂光點，樣式跟點擊都自己接管 */
  _tourItemHotspot(h) {
    return {
      pitch: h.pitch,
      yaw: h.yaw,
      cssClass: "hotspot",
      createTooltipFunc: (div) => {
        div.innerHTML = '<span class="hotspot-dot"></span>';
        const item = TOUR_ITEMS.find((i) => i.id === h.tourItemId);
        div.setAttribute("aria-label", item ? tUi("viewLabel") + tItem(item, "title") : h.tourItemId);
      },
      clickHandlerFunc: () => this.onHotspotClick(h.tourItemId),
    };
  }

  enter() {
    this.viewer = pannellum.viewer(this.containerId, this._buildConfig());
    this.currentSceneId = ENTRY_SCENE_ID;
    this.history = [];
    this.viewer.on("scenechange", (sceneId) => this._onSceneChange(sceneId));
    if (PANO_DEBUG) this._mountDebugPicker();
    // autoLoad 關掉了，這裡要自己明確載入第一個場景（以前是靠 autoLoad:true 自動做這件事）
    this.viewer.loadScene(ENTRY_SCENE_ID);
    // 這個 loadScene() 呼叫會非同步觸發 scenechange，但監聽器上面剛掛上，理論上接得到；
    // 保留手動補發一次是雙重保險，不會有副作用（sceneId 跟 currentSceneId 相同不會誤推歷史）
    this._onSceneChange(ENTRY_SCENE_ID);
  }

  _onSceneChange(sceneId) {
    if (!this._suppressHistoryPush && sceneId !== this.currentSceneId) {
      this.history.push(this.currentSceneId);
    }
    this._suppressHistoryPush = false;
    this.currentSceneId = sceneId;
    const scene = SCENES.find((s) => s.id === sceneId);
    debugLog("scenechange → " + sceneId);
    this._emit("scene:change", { scene });
    this._emit("history:change", { canGoBack: this.canGoBack() });

    // 換場景那 900ms（sceneFadeDuration）淡入淡出還沒播完時，先把按鈕列擋掉。沒擋的話，
    // 連點兩下會在 Pannellum 上一次的圖還在載入／淡出中就打斷它，內部負責讀圖的物件被清掉，
    // 回呼再想寫入就會炸「Cannot set properties of undefined (setting 'src')」——這是 Pannellum
    // 沒防連點的已知行為，跟按鈕是固定的還是 3D 浮動的無關，這裡統一擋。
    document.body.classList.add("is-transitioning");
    clearTimeout(this._transitionTimer);
    this._transitionTimer = setTimeout(() => document.body.classList.remove("is-transitioning"), 950);
  }

  /** 回到一個已知樞紐，丟掉「進支線之後」那一段歷史（語意跟 V2 resetTo 一樣） */
  resetTo(id) {
    const idx = this.history.lastIndexOf(id);
    if (idx !== -1) this.history = this.history.slice(0, idx);
    else this.history.push(this.currentSceneId);
    this._suppressHistoryPush = true;
    this.viewer.loadScene(id);
  }

  /** 通用上一步 */
  goBack() {
    if (!this.canGoBack()) return;
    const prevId = this.history.pop();
    this._suppressHistoryPush = true;
    this.viewer.loadScene(prevId);
  }

  /** 語言切換時：重繪目前場景的光點文字，鏡頭視角維持不動（不當成一次「移動」，不推入歷史） */
  relabel() {
    if (!this.viewer) return;
    // 語言切換時整個 viewer 會 destroy() 重建（見下面註解）。如果上一次重建的圖還沒讀完，
    // 又被連續點語言切換觸發下一次 destroy()，舊的讀圖流程被攔腰打斷，它的回呼稍後想寫入
    // 已經不存在的物件就會炸「Cannot set properties of undefined (setting 'src')」——
    // 跟之前連點場景光點是同一種問題。這裡不是單純擋掉連點（那樣連點最後一次可能被吃掉，
    // 光點文字停在切換途中的語言、跟畫面其他地方顯示的語言對不上），而是「正在重建時再被
    // 呼叫，記一筆待處理，等這次重建完再補做一次」，確保最後停在哪個語言，全畫面都會一致。
    //
    // 這裡用一個遞增的 token 標記「這是第幾次重建」：上一版的 bug 是 3 秒保險計時器在
    // 'load' 事件已經正常觸發、鎖已經放開之後，沒有被清掉——3 秒後它自己又醒來，把鎖
    // 誤放給了「下一次」還在讀圖中的重建，導致不是連點也會踩到同一個崩潰。現在 'load'
    // 事件跟保險計時器都帶著自己那一輪的 token，只有 token 對得上目前這一輪的，才准放鎖。
    if (this._isRelabeling) { this._relabelPending = true; return; }
    this._isRelabeling = true;
    const token = ++this._relabelToken;
    const pitch = this.viewer.getPitch();
    const yaw = this.viewer.getYaw();
    const hfov = this.viewer.getHfov();
    this._suppressHistoryPush = true;
    // 重建 config 是因為 tooltip 文字（title、光點 label）是在建立當下讀 CURRENT_LANG 寫死進 DOM 的，
    // 語言切換後最乾淨的做法就是照目前視角原地重載一次，而不是自己再寫一套「找 DOM 改文字」的邏輯
    this.viewer.destroy();
    this.viewer = pannellum.viewer(this.containerId, this._buildConfig());
    this.viewer.on("scenechange", (sceneId) => this._onSceneChange(sceneId));
    this.viewer.on("load", () => this._onRelabelDone(token));
    // 保險：萬一某些情況 load 事件沒觸發（例如圖片讀取失敗），3 秒後還是把鎖放開，
    // 不要讓語言切換整個卡死不能再用
    clearTimeout(this._relabelSafetyTimer);
    this._relabelSafetyTimer = setTimeout(() => this._onRelabelDone(token), 3000);
    this._suppressHistoryPush = true;
    this.viewer.loadScene(this.currentSceneId, pitch, yaw, hfov);
  }

  _onRelabelDone(token) {
    if (token !== this._relabelToken) return; // 過期的 load 事件／計時器，不是目前這一輪，不理它
    clearTimeout(this._relabelSafetyTimer);
    this._isRelabeling = false;
    if (this._relabelPending) {
      this._relabelPending = false;
      this.relabel();
    }
  }

  /** 目前這個場景的所有出口（固定按鈕列用），advance 排前面、branch 接在後面 */
  getExits() {
    const scene = SCENES.find((s) => s.id === this.currentSceneId);
    if (!scene) return [];
    return scene.exits;
  }

  /** 點固定按鈕列裡任何一顆出口按鈕都走這裡：reset 型丟給 resetTo() 清歷史，
   * 其餘（advance／一般 branch）直接 loadScene，帶 targetYaw/targetPitch 讓下一景一開始
   * 面向正確方向。淡入淡出沿用 config.sceneFadeDuration，跟其他轉場是同一套，不會不一致 */
  goExit(exit) {
    if (!this.viewer) return;
    if (exit.reset) { this.resetTo(exit.toSceneId); return; }
    this.viewer.loadScene(exit.toSceneId, exit.targetPitch ?? 0, exit.targetYaw ?? 0);
  }

  _mountDebugPicker() {
    const readout = document.createElement("div");
    readout.id = "pano-debug-readout";
    readout.style.cssText =
      "position:fixed;left:12px;bottom:12px;z-index:9999;background:rgba(0,0,0,0.75);color:#7CFC9A;" +
      "font:13px/1.4 monospace;padding:8px 12px;border-radius:6px;pointer-events:none;white-space:pre;";
    readout.textContent = "點畫面任一處，這裡會印出 pitch / yaw";
    document.body.appendChild(readout);
    document.getElementById(this.containerId).addEventListener("click", (e) => {
      if (!this.viewer) return;
      const coords = this.viewer.mouseEventToCoords(e);
      const line = `pitch: ${coords[0].toFixed(1)}, yaw: ${coords[1].toFixed(1)}   （場景：${this.currentSceneId}）`;
      readout.textContent = line;
      console.log(line);
    });
  }

  toggleGyro() {
    if (!this.viewer) return;
    this.viewer.toggleOrientation ? this.viewer.toggleOrientation() : null;
  }
}

// ============================================================
// 圖片放大 Modal（沿用 V2）
// ============================================================
function openImageModal(src, alt) {
  const modal = document.getElementById("image-modal");
  document.getElementById("image-modal-img").src = src;
  document.getElementById("image-modal-img").alt = alt || "";
  modal.hidden = false;
}
function closeImageModal() {
  const modal = document.getElementById("image-modal");
  modal.hidden = true;
  document.getElementById("image-modal-img").src = "";
}

// ============================================================
// 音檔播放器（沿用 V2）
// ============================================================
let currentItemId = null;
const audioEl = () => document.getElementById("audio-element");

function showAudioDock() {
  document.getElementById("audio-dock").hidden = false;
  document.body.classList.add("has-audio-dock");
}
function hideAudioDock() {
  document.getElementById("audio-dock").hidden = true;
  document.body.classList.remove("has-audio-dock");
  audioEl().pause();
}
function setPlayButtonState(isPlaying) {
  const btn = document.getElementById("audio-play-btn");
  btn.textContent = isPlaying ? "❚❚" : "▶";
  btn.setAttribute("aria-label", isPlaying ? "Pause" : "Lecture");
}
function playItem(itemId) {
  const item = TOUR_ITEMS.find((i) => i.id === itemId);
  if (!item) return;
  currentItemId = itemId;
  const audio = audioEl();
  // tItem() 用的是跟 title/label 一樣的欄位命名慣例：中／英文檔如果錄好了，
  // 在 data.js 該筆項目補上 audio_en / audio_zh（audioDuration 同理），沒有的話自動退回法文，
  // 不用另外寫判斷式——語言切換、播放器全部沿用同一套 tItem() 邏輯
  audio.src = tItem(item, "audio");
  audio.playbackRate = parseFloat(document.getElementById("audio-speed").value || "1");

  document.getElementById("audio-dock-eyebrow").textContent = "N° " + item.id + " · " + tArea(item.area);
  document.getElementById("audio-dock-title").textContent = tItem(item, "title");
  document.getElementById("audio-duration").textContent = formatTime(tItem(item, "audioDuration"));
  document.getElementById("audio-seek").value = 0;
  document.getElementById("audio-current-time").textContent = "0:00";

  showAudioDock();
  const p = audio.play();
  if (p && p.catch) p.catch(() => setPlayButtonState(false));
  setPlayButtonState(true);
}
function togglePlayPause() {
  const audio = audioEl();
  if (!currentItemId) return;
  if (audio.paused) { audio.play().catch(() => {}); setPlayButtonState(true); }
  else { audio.pause(); setPlayButtonState(false); }
}
function playRelative(offset) {
  if (!currentItemId) return;
  const idx = TOUR_ITEMS.findIndex((i) => i.id === currentItemId);
  const target = TOUR_ITEMS[idx + offset];
  if (target) playItem(target.id);
}
function initAudioPlayer() {
  const audio = audioEl();
  let isSeeking = false;

  audio.addEventListener("timeupdate", () => {
    if (isSeeking) return;
    const item = TOUR_ITEMS.find((i) => i.id === currentItemId);
    const duration = isFinite(audio.duration) ? audio.duration : (item ? tItem(item, "audioDuration") : 0);
    document.getElementById("audio-seek").value = String(duration ? (audio.currentTime / duration) * 100 : 0);
    document.getElementById("audio-current-time").textContent = formatTime(audio.currentTime);
  });
  audio.addEventListener("loadedmetadata", () => {
    if (isFinite(audio.duration)) document.getElementById("audio-duration").textContent = formatTime(audio.duration);
  });
  audio.addEventListener("ended", () => { setPlayButtonState(false); });
  audio.addEventListener("play", () => setPlayButtonState(true));
  audio.addEventListener("pause", () => setPlayButtonState(false));

  document.getElementById("audio-play-btn").addEventListener("click", togglePlayPause);
  document.getElementById("audio-prev-btn").addEventListener("click", () => playRelative(-1));
  document.getElementById("audio-next-btn").addEventListener("click", () => playRelative(1));
  document.getElementById("audio-replay-btn").addEventListener("click", () => {
    audio.currentTime = 0;
    document.getElementById("audio-current-time").textContent = "0:00";
    document.getElementById("audio-seek").value = 0;
  });
  document.getElementById("audio-close-btn").addEventListener("click", hideAudioDock);
  document.getElementById("audio-volume").addEventListener("input", (e) => {
    audio.volume = Number(e.target.value) / 100;
  });
  document.getElementById("audio-speed").addEventListener("change", (e) => {
    audio.playbackRate = parseFloat(e.target.value);
  });
  document.getElementById("audio-seek").addEventListener("input", () => { isSeeking = true; });
  document.getElementById("audio-seek").addEventListener("change", (e) => {
    const item = TOUR_ITEMS.find((i) => i.id === currentItemId);
    const duration = isFinite(audio.duration) ? audio.duration : (item ? tItem(item, "audioDuration") : 0);
    audio.currentTime = (Number(e.target.value) / 100) * duration;
    isSeeking = false;
  });

  document.getElementById("image-modal-close").addEventListener("click", closeImageModal);
  document.getElementById("image-modal-backdrop").addEventListener("click", closeImageModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("image-modal").hidden) closeImageModal();
  });
}

// ============================================================
// InfoPanel（沿用 V2 的 tour-item 卡片結構）
// ============================================================
function renderInfoPanel(tourItemId, onClose) {
  const item = TOUR_ITEMS.find((i) => i.id === tourItemId);
  if (!item) return null;

  const title = tItem(item, "title");
  const shortDescription = tItem(item, "shortDescription");
  const fullText = tItem(item, "fullText");

  const wrap = el("div", { class: "info-panel" }, [
    el("button", { class: "info-panel__close", "aria-label": "關閉" }, ["\u00d7"]),
    el("article", { class: "tour-item" }, [
      el("div", { class: "tour-item-head" }, [
        el("div", { class: "tour-item-media" }, [
          el(
            "button",
            { "aria-label": "Agrandir l'image : " + title, onclick: () => openImageModal(item.image, item.imageAlt) },
            [el("img", { src: item.image, alt: item.imageAlt || "" })]
          ),
          el("p", { class: "tour-item-media-caption" }, ["Touchez l'image pour l'agrandir"]),
        ]),
        el("div", { class: "tour-item-tags" }, [
          el("span", { class: "tour-item-tag" }, ["N° " + item.id]),
          el("span", { class: "tour-item-tag" }, [item.category]),
          el("span", { class: "tour-item-tag" }, [tArea(item.area)]),
        ]),
      ]),
      el("div", { class: "tour-item-summary-card" }, [
        el("h2", { class: "tour-item-title" }, [title]),
        el("p", { class: "tour-item-short" }, [shortDescription]),
        el("div", { class: "tour-item-actions" }, [
          el("button", { class: "btn btn-primary", onclick: () => playItem(item.id) }, ["▶ Écouter le commentaire"]),
        ]),
      ]),
      el("div", { class: "tour-item-divider" }),
      el("div", { class: "tour-item-body" }, fullText.map((para) => el("p", null, [para]))),
    ]),
  ]);

  wrap.querySelector(".info-panel__close").addEventListener("click", onClose);
  return wrap;
}

// ============================================================
// Sommaire（沿用 V2）
// ============================================================
function renderSommaire(onItemClick, activeItemId) {
  const el2 = document.createElement("nav");
  el2.className = "sommaire";
  AREAS.forEach((area) => {
    const group = document.createElement("div");
    group.className = "sommaire__group";
    group.innerHTML = `<h3>${tArea(area)}</h3>`;
    TOUR_ITEMS.filter((i) => i.area === area).forEach((item) => {
      const btn = document.createElement("button");
      btn.className = "sommaire__item" + (item.id === activeItemId ? " sommaire__item--active" : "");
      btn.textContent = `${item.order}. ${tItem(item, "title")}`;
      btn.addEventListener("click", () => onItemClick(item.id));
      group.appendChild(btn);
    });
    el2.appendChild(group);
  });
  return el2;
}

// ============================================================
// 開場門
// ============================================================
function playDoorTransition(doorEl, onMidpoint) {
  const duration = 1100;
  doorEl.style.transition = `opacity ${duration}ms ease-in-out, transform ${duration}ms ease-in-out`;
  doorEl.style.transform = "scale(1.2)";
  doorEl.style.opacity = "0";
  onMidpoint?.();
  return new Promise((resolve) => setTimeout(() => { doorEl.hidden = true; resolve(); }, duration));
}
function mountDoorIntro(doorEl, ctaEl, engine, onDone) {
  ctaEl.addEventListener("click", async () => {
    await playDoorTransition(doorEl, () => engine.enter());
    onDone?.();
  });
}

// ============================================================
// 組裝
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  const infoPanelSlot = document.getElementById("info-panel-slot");
  const sommaireSlot = document.getElementById("sommaire-slot");
  const doorEl = document.getElementById("door-intro");
  const doorCta = document.getElementById("door-cta");
  const sommaireToggle = document.getElementById("sommaire-toggle");
  const backBtn = document.getElementById("back-btn");
  const navBar = document.getElementById("nav-bar");
  const navPrimary = document.getElementById("nav-primary");
  const langToggle = document.getElementById("lang-toggle");
  const gyroBtn = document.getElementById("gyro-toggle");
  const sommaireBody = document.getElementById("sommaire-body");
  const sommaireClose = document.getElementById("sommaire-close");
  const sommaireHeaderTitle = document.getElementById("sommaire-header-title");

  let openItemId = null;

  function openInfoPanel(tourItemId) {
    openItemId = tourItemId;
    infoPanelSlot.innerHTML = "";
    const panel = renderInfoPanel(tourItemId, () => {
      openItemId = null;
      infoPanelSlot.innerHTML = "";
      refreshSommaire(); // 關掉資訊卡時，目錄裡的「目前位置」高亮也要跟著消失
    });
    if (panel) infoPanelSlot.appendChild(panel);
    refreshSommaire(); // 打開資訊卡時，目錄裡對應那行馬上標成「目前位置」
  }

  function closeSommaire() {
    sommaireSlot.classList.remove("is-open");
    sommaireToggle.hidden = false;
  }
  function openSommaire() {
    sommaireSlot.classList.add("is-open");
    // 側欄打開時把外面那顆「☰ 目錄」藏起來——它固定在畫面左上角，跟側欄自己的位置
    // 疊在一起；側欄往下捲動時，捲上來的項目文字會跑到它底下，看起來像「目錄」按鈕
    // 沒有跟著黏住／飄在畫面上很怪，其實是兩個各自獨立的固定元素疊在同一個角落。
    // 側欄現在自己有標題列＋關閉鈕（#sommaire-close），不需要外面這顆同時存在。
    sommaireToggle.hidden = true;
  }

  function refreshSommaire() {
    sommaireBody.innerHTML = "";
    sommaireBody.appendChild(renderSommaire((id) => {
      openInfoPanel(id);
      closeSommaire();
    }, openItemId));
  }

  /** 目前這個場景所有的出口都在這裡：advance 併進 #nav-primary 跟「上一步」包成同一顆膠囊
   * （照你紅筆圈的畫法），branch（分岔）維持各自獨立的按鈕，排在 #nav-primary 外面。
   * 只清掉上一次動態產生的 .exit-pill，不動 #back-btn 這個固定存在的手足節點 */
  function refreshExitBar() {
    navBar.querySelectorAll(".exit-pill").forEach((el) => el.remove());
    engine.getExits().forEach((exit) => {
      const btn = document.createElement("button");
      btn.className = "exit-pill exit-pill--" + exit.type;
      const arrow = exit.type === "branch" ? (exit.side === "left" ? "↖ " : "↗ ") : "↑ ";
      btn.textContent = arrow + tItem(exit, "label");
      btn.addEventListener("click", () => engine.goExit(exit));
      if (exit.type === "advance") navPrimary.appendChild(btn);
      else navBar.appendChild(btn);
    });
  }

  function applyUiStrings() {
    sommaireToggle.textContent = tUi("sommaireToggle");
    sommaireToggle.setAttribute("aria-label", tUi("sommaireToggleLabel"));
    sommaireHeaderTitle.textContent = tUi("sommaireToggle").replace("☰ ", "");
    backBtn.setAttribute("aria-label", tUi("backBtnLabel"));
    backBtn.textContent = tUi("backBtn");
    gyroBtn.setAttribute("aria-label", tUi("gyroLabel"));
    refreshExitBar();
  }

  const engine = new PanoEngine("pano", openInfoPanel);
  initAudioPlayer();

  refreshSommaire();
  applyUiStrings();

  langToggle.textContent = LANG_SHORT_LABEL[CURRENT_LANG];
  langToggle.addEventListener("click", () => {
    const nextIdx = (LANG_ORDER.indexOf(CURRENT_LANG) + 1) % LANG_ORDER.length;
    setLang(LANG_ORDER[nextIdx]);
    langToggle.textContent = LANG_SHORT_LABEL[CURRENT_LANG];
    applyUiStrings();
    engine.relabel();
    refreshSommaire();
    if (openItemId) openInfoPanel(openItemId);
  });

  sommaireToggle.addEventListener("click", openSommaire);
  sommaireClose.addEventListener("click", closeSommaire);
  document.getElementById("pano").addEventListener("click", () => {
    if (sommaireSlot.classList.contains("is-open")) closeSommaire();
  });
  backBtn.addEventListener("click", () => engine.goBack());
  engine.on("history:change", ({ canGoBack }) => { backBtn.hidden = !canGoBack; });
  engine.on("scene:change", () => refreshExitBar());
  gyroBtn.addEventListener("click", () => engine.toggleGyro());

  mountDoorIntro(doorEl, doorCta, engine, () => {});
});