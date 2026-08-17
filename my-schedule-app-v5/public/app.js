(() => {
  "use strict";

  /* ---------------- Storage ---------------- */
  const STORAGE_KEY = "scheduleApp.items.v1";
  const SETTINGS_KEY = "scheduleApp.settings.v1";
  const SYNC_CODE_KEY = "scheduleApp.syncCode.v1";

  function getSyncCode() {
    return localStorage.getItem(SYNC_CODE_KEY) || "";
  }

  function setSyncCode(code) {
    localStorage.setItem(SYNC_CODE_KEY, code);
  }

  function clearSyncCode() {
    localStorage.removeItem(SYNC_CODE_KEY);
  }

  function loadItems() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      console.error("failed to load items", e);
      return [];
    }
  }

  function saveItems(items) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return raw ? JSON.parse(raw) : { showDone: false };
    } catch (e) {
      return { showDone: false };
    }
  }

  function saveSettings(settings) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  /* ---------------- State ---------------- */
  const COLORS = [
    { key: "indigo", value: "#4F46E5" },
    { key: "sky", value: "#0EA5E9" },
    { key: "emerald", value: "#059669" },
    { key: "amber", value: "#D97706" },
    { key: "pink", value: "#DB2777" },
    { key: "gray", value: "#6B7280" }
  ];

  const state = {
    items: loadItems(),
    settings: loadSettings(),
    currentMonth: startOfMonth(new Date()),
    selectedDateKey: dateKey(new Date()),
    editingId: null,
    editingType: "todo",
    summaryPromptId: null,
    currentView: "calendarView",
    modalColor: COLORS[0].key,
    syncing: false,
    lastSyncAt: null
  };

  /* ---------------- Push notifications ---------------- */
  // Public key only — safe to ship in client code. Paired private key lives
  // only in the Netlify site's environment variables, never in this file.
  const VAPID_PUBLIC_KEY = "BCf7iT9tgq3L8E5qdU6h3r40OxF0Q6N4zv1UeilitfQuROSzaX0YrKksnvfvhkOfKrilomUi7f7IlXFrbf06Jxs";

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  function pushSupported() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  }

  async function getExistingSubscription() {
    if (!pushSupported()) return null;
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }

  // Ensures the browser is subscribed to push and the subscription is saved
  // server-side. Returns true only if notifications are actually ready to fire.
  async function ensurePushSubscribed() {
    if (!pushSupported()) {
      showToast("이 브라우저는 알림을 지원하지 않아요");
      return false;
    }
    if (!getSyncCode()) {
      showToast("먼저 🔄 기기 연결에서 동기화 코드를 입력해주세요");
      return false;
    }
    if (Notification.permission === "denied") {
      showToast("알림이 차단되어 있어요. 브라우저 설정에서 허용해주세요");
      return false;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          showToast("알림 권한이 필요해요");
          return false;
        }
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
        });
        const res = await fetch("/.netlify/functions/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Sync-Code": getSyncCode() },
          body: JSON.stringify({ subscription: sub.toJSON() })
        }).catch(() => null);
        if (!res || !res.ok) {
          showToast("알림 등록에 실패했어요. 동기화 코드를 확인해주세요");
          return false;
        }
      }
      return true;
    } catch (err) {
      console.warn("push subscribe failed", err);
      showToast("알림을 켜지 못했어요. 배포된 주소(https)에서만 동작해요");
      return false;
    }
  }

  /* ---------------- Cross-device sync ---------------- */
  // Server is the shared source of truth once paired; localStorage stays as
  // an instant offline cache. Conflicts are resolved last-write-wins by
  // comparing `updatedAt` per item (see netlify/functions/sync-items.js).

  function pushItemToServer(item) {
    const code = getSyncCode();
    if (!code) return;
    fetch("/.netlify/functions/sync-items", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sync-Code": code },
      body: JSON.stringify({ item })
    }).catch(() => {});
  }

  function mergeServerItems(serverItems) {
    const byId = new Map(state.items.map((it) => [it.id, it]));
    let changed = false;
    const toPush = [];

    serverItems.forEach((serverItem) => {
      const local = byId.get(serverItem.id);
      if (!local) {
        byId.set(serverItem.id, serverItem);
        changed = true;
        return;
      }
      const localTime = local.updatedAt || local.createdAt || 0;
      const serverTime = serverItem.updatedAt || 0;
      if (serverTime > localTime) {
        byId.set(serverItem.id, serverItem);
        changed = true;
      } else if (localTime > serverTime) {
        // Our local copy is newer than what the server had — push it back
        // so the other device picks it up too.
        toPush.push(local);
      }
    });

    // Items that exist locally but the server has never seen yet.
    const serverIds = new Set(serverItems.map((it) => it.id));
    byId.forEach((item, id) => {
      if (!serverIds.has(id)) toPush.push(item);
    });

    if (changed) {
      state.items = Array.from(byId.values());
      saveItems(state.items);
    }
    toPush.forEach(pushItemToServer);
    return changed;
  }

  async function pullFromServer(showFeedback) {
    const code = getSyncCode();
    if (!code || state.syncing) return;
    state.syncing = true;
    try {
      const res = await fetch("/.netlify/functions/sync-items", {
        headers: { "X-Sync-Code": code }
      });
      if (res.status === 401) {
        showToast("동기화 코드가 올바르지 않아요");
        clearSyncCode();
        refreshSyncStatus();
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      const changed = mergeServerItems(data.items || []);
      state.lastSyncAt = Date.now();
      if (changed) renderAll();
      if (showFeedback) refreshSyncStatus();
    } catch (err) {
      // Offline or unreachable — silently keep using local data.
    } finally {
      state.syncing = false;
    }
  }

  /* ---------------- Date helpers ---------------- */
  function dateKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function startOfMonth(d) {
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }

  function addMonths(d, n) {
    return new Date(d.getFullYear(), d.getMonth() + n, 1);
  }

  function isSameDate(a, b) {
    return a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();
  }

  function formatMonthLabel(d) {
    return `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
  }

  function formatDetailLabel(key) {
    const d = new Date(key + "T00:00:00");
    const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
    const today = dateKey(new Date());
    const prefix = key === today ? "오늘 · " : "";
    return `${prefix}${d.getMonth() + 1}월 ${d.getDate()}일 (${weekdays[d.getDay()]})`;
  }

  function formatTime(t) {
    if (!t) return "";
    const [h, m] = t.split(":").map(Number);
    const period = h < 12 ? "오전" : "오후";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${period} ${h12}:${String(m).padStart(2, "0")}`;
  }

  function colorValue(key) {
    const found = COLORS.find((c) => c.key === key);
    return found ? found.value : COLORS[0].value;
  }

  function quadrantOf(item) {
    if (item.important && item.urgent) return "q1";
    if (item.important && !item.urgent) return "q2";
    if (!item.important && item.urgent) return "q3";
    return "q4";
  }

  function uid() {
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  /* ---------------- DOM refs ---------------- */
  const $ = (sel) => document.querySelector(sel);

  const els = {
    monthLabel: $("#monthLabel"),
    calendarGrid: $("#calendarGrid"),
    dayDetailLabel: $("#dayDetailLabel"),
    dayDetailList: $("#dayDetailList"),
    dayDetailEmpty: $("#dayDetailEmpty"),
    prevMonthBtn: $("#prevMonthBtn"),
    nextMonthBtn: $("#nextMonthBtn"),
    todayBtn: $("#todayBtn"),
    matrixLists: {
      q1: document.querySelector('[data-list="q1"]'),
      q2: document.querySelector('[data-list="q2"]'),
      q3: document.querySelector('[data-list="q3"]'),
      q4: document.querySelector('[data-list="q4"]')
    },
    showDoneToggle: $("#showDoneToggle"),
    tabBtns: document.querySelectorAll(".tab-btn"),
    views: { calendarView: $("#calendarView"), matrixView: $("#matrixView"), readView: $("#readView") },
    readQueueList: $("#readQueueList"),
    readQueueEmpty: $("#readQueueEmpty"),
    readDoneList: $("#readDoneList"),
    readDoneEmpty: $("#readDoneEmpty"),
    exportReadBtn: $("#exportReadBtn"),
    addBtn: $("#addBtn"),
    modalOverlay: $("#modalOverlay"),
    modalTitle: $("#modalTitle"),
    itemForm: $("#itemForm"),
    fieldTitle: $("#fieldTitle"),
    urlFieldWrap: $("#urlFieldWrap"),
    fieldUrl: $("#fieldUrl"),
    fieldDate: $("#fieldDate"),
    fieldTime: $("#fieldTime"),
    fieldMemo: $("#fieldMemo"),
    summaryFieldWrap: $("#summaryFieldWrap"),
    fieldSummary: $("#fieldSummary"),
    colorPicker: $("#colorPicker"),
    priorityFieldWrap: $("#priorityFieldWrap"),
    fieldImportant: $("#fieldImportant"),
    fieldUrgent: $("#fieldUrgent"),
    remindFieldWrap: $("#remindFieldWrap"),
    fieldRemind: $("#fieldRemind"),
    remindHint: $("#remindHint"),
    doneFieldWrap: $("#doneFieldWrap"),
    fieldDone: $("#fieldDone"),
    fieldDoneLabel: $("#fieldDoneLabel"),
    deleteBtn: $("#deleteBtn"),
    cancelBtn: $("#cancelBtn"),
    toast: $("#toast"),
    notifyBtn: $("#notifyBtn"),
    notifyModalOverlay: $("#notifyModalOverlay"),
    notifyStatus: $("#notifyStatus"),
    notifyEnableBtn: $("#notifyEnableBtn"),
    notifyTestBtn: $("#notifyTestBtn"),
    notifyCloseBtn: $("#notifyCloseBtn"),
    summaryPromptOverlay: $("#summaryPromptOverlay"),
    summaryPromptTitle: $("#summaryPromptTitle"),
    summaryPromptText: $("#summaryPromptText"),
    summarySaveBtn: $("#summarySaveBtn"),
    summarySkipBtn: $("#summarySkipBtn"),
    summaryCancelBtn: $("#summaryCancelBtn"),
    syncBtn: $("#syncBtn"),
    syncModalOverlay: $("#syncModalOverlay"),
    syncStatus: $("#syncStatus"),
    syncPairForm: $("#syncPairForm"),
    syncCodeInput: $("#syncCodeInput"),
    syncConnectBtn: $("#syncConnectBtn"),
    syncConnectedInfo: $("#syncConnectedInfo"),
    syncDisconnectBtn: $("#syncDisconnectBtn"),
    syncCloseBtn: $("#syncCloseBtn")
  };

  /* ---------------- Rendering: calendar ---------------- */
  function renderCalendar() {
    els.monthLabel.textContent = formatMonthLabel(state.currentMonth);
    els.calendarGrid.innerHTML = "";

    const year = state.currentMonth.getFullYear();
    const month = state.currentMonth.getMonth();
    const firstWeekday = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();

    const cells = [];
    for (let i = firstWeekday - 1; i >= 0; i--) {
      cells.push({ day: daysInPrevMonth - i, muted: true, date: new Date(year, month - 1, daysInPrevMonth - i) });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ day: d, muted: false, date: new Date(year, month, d) });
    }
    while (cells.length % 7 !== 0 || cells.length < 42) {
      const nextIndex = cells.length - (firstWeekday + daysInMonth) + 1;
      cells.push({ day: nextIndex, muted: true, date: new Date(year, month + 1, nextIndex) });
    }

    const today = new Date();
    const frag = document.createDocumentFragment();

    cells.forEach((cell) => {
      const key = dateKey(cell.date);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "day-cell";
      if (cell.muted) btn.classList.add("muted");
      if (isSameDate(cell.date, today)) btn.classList.add("today");
      if (key === state.selectedDateKey) btn.classList.add("selected");

      const num = document.createElement("span");
      num.textContent = cell.day;
      btn.appendChild(num);

      const dayItems = state.items.filter((it) => !it.deleted && it.type !== "read" && it.date === key);
      if (dayItems.length) {
        const dots = document.createElement("span");
        dots.className = "dots";
        dayItems.slice(0, 3).forEach((it) => {
          const dot = document.createElement("span");
          dot.className = "dot";
          dot.style.background = colorValue(it.color);
          dots.appendChild(dot);
        });
        btn.appendChild(dots);
      }

      btn.addEventListener("click", () => {
        state.selectedDateKey = key;
        if (cell.muted) {
          state.currentMonth = startOfMonth(cell.date);
        }
        renderCalendar();
        renderDayDetail();
      });

      frag.appendChild(btn);
    });

    els.calendarGrid.appendChild(frag);
  }

  function renderDayDetail() {
    els.dayDetailLabel.textContent = formatDetailLabel(state.selectedDateKey);
    const items = state.items
      .filter((it) => !it.deleted && it.type !== "read" && it.date === state.selectedDateKey)
      .sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"));

    els.dayDetailList.innerHTML = "";
    els.dayDetailEmpty.hidden = items.length !== 0;

    items.forEach((item) => {
      els.dayDetailList.appendChild(buildItemCard(item, { showDate: false }));
    });
  }

  /* ---------------- Rendering: matrix ---------------- */
  function renderMatrix() {
    const groups = { q1: [], q2: [], q3: [], q4: [] };
    state.items.forEach((item) => {
      if (item.deleted || item.type === "read") return;
      if (item.done && !state.settings.showDone) return;
      groups[quadrantOf(item)].push(item);
    });

    Object.keys(groups).forEach((q) => {
      const list = els.matrixLists[q];
      list.innerHTML = "";
      const sorted = groups[q].sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1;
        return (a.date || "9999-99-99").localeCompare(b.date || "9999-99-99");
      });
      if (!sorted.length) {
        const empty = document.createElement("li");
        empty.className = "empty-hint";
        empty.textContent = "항목이 없어요";
        list.appendChild(empty);
        return;
      }
      sorted.forEach((item) => list.appendChild(buildItemCard(item, { showDate: true })));
    });
  }

  /* ---------------- Rendering: reading list ---------------- */
  function renderReadList() {
    const all = state.items.filter((it) => !it.deleted && it.type === "read");

    const queue = all
      .filter((it) => !it.done)
      .sort((a, b) => {
        const aKey = a.remindAt || "9999";
        const bKey = b.remindAt || "9999";
        if (aKey !== bKey) return aKey.localeCompare(bKey);
        return (b.createdAt || 0) - (a.createdAt || 0);
      });

    const done = all
      .filter((it) => it.done)
      .sort((a, b) => (b.readAt || b.createdAt || 0) - (a.readAt || a.createdAt || 0));

    els.readQueueList.innerHTML = "";
    els.readQueueEmpty.hidden = queue.length !== 0;
    queue.forEach((item) => els.readQueueList.appendChild(buildItemCard(item, { showDate: true })));

    els.readDoneList.innerHTML = "";
    els.readDoneEmpty.hidden = done.length !== 0;
    done.forEach((item) => els.readDoneList.appendChild(buildItemCard(item, { showDate: true })));
  }

  // Lets the user keep their reading notes even if they clear the browser
  // or switch phones — everything else stays local-only by design.
  function exportReadArchive() {
    const done = state.items
      .filter((it) => !it.deleted && it.type === "read" && it.done)
      .sort((a, b) => (b.readAt || b.createdAt || 0) - (a.readAt || a.createdAt || 0));

    if (!done.length) {
      showToast("아직 내보낼 기록이 없어요");
      return;
    }

    const pad2 = (n) => String(n).padStart(2, "0");
    const lines = ["# 읽은 기록", ""];
    done.forEach((item) => {
      const d = item.readAt ? new Date(item.readAt) : null;
      const dateStr = d ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : "";
      lines.push(`## ${item.title}`);
      if (dateStr) lines.push(`- 읽은 날짜: ${dateStr}`);
      if (item.url) lines.push(`- 링크: ${item.url}`);
      if (item.summary) lines.push(`- 요약: ${item.summary}`);
      lines.push("");
    });

    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const today = new Date();
    const stamp = `${today.getFullYear()}${pad2(today.getMonth() + 1)}${pad2(today.getDate())}`;

    const a = document.createElement("a");
    a.href = url;
    a.download = `reading-notes-${stamp}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("파일로 내보냈어요");
  }

  /* ---------------- Shared item card ---------------- */
  function buildItemCard(item, opts) {
    const li = document.createElement("li");
    li.className = "item-card" + (item.done ? " done" : "");

    const colorBar = document.createElement("span");
    colorBar.className = "item-color";
    colorBar.style.background = colorValue(item.color);
    li.appendChild(colorBar);

    const check = document.createElement("button");
    check.type = "button";
    check.className = "item-check" + (item.done ? " checked" : "");
    check.textContent = "✓";
    check.setAttribute("aria-label", "완료 표시");
    check.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleDone(item.id);
    });
    li.appendChild(check);

    const body = document.createElement("div");
    body.className = "item-body";

    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = item.title;
    body.appendChild(title);

    const metaParts = [];
    if (opts.showDate && item.date) {
      const d = new Date(item.date + "T00:00:00");
      metaParts.push(`${d.getMonth() + 1}/${d.getDate()}`);
    }
    if (item.time) metaParts.push(formatTime(item.time));
    if (item.memo) metaParts.push(item.memo);

    if (metaParts.length || item.remindEnabled || (item.type === "read" && item.done && item.readAt)) {
      const meta = document.createElement("div");
      meta.className = "item-meta";
      if (metaParts.length) {
        const text = document.createElement("span");
        text.textContent = metaParts.join(" · ");
        meta.appendChild(text);
      }
      if (item.remindEnabled) {
        const badge = document.createElement("span");
        badge.className = "remind-badge";
        badge.textContent = "🔔 알림";
        meta.appendChild(badge);
      }
      if (item.type === "read" && item.done && item.readAt) {
        const readBadge = document.createElement("span");
        readBadge.className = "remind-badge";
        const d = new Date(item.readAt);
        readBadge.textContent = `📚 ${d.getMonth() + 1}/${d.getDate()} 읽음`;
        meta.appendChild(readBadge);
      }
      body.appendChild(meta);
    }

    if (item.type === "read" && item.summary) {
      const summaryEl = document.createElement("div");
      summaryEl.className = "item-summary";
      summaryEl.textContent = item.summary;
      body.appendChild(summaryEl);
    }

    if (item.type === "read" && item.url) {
      const link = document.createElement("a");
      link.className = "item-link";
      link.href = item.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "열어보기 ↗";
      link.addEventListener("click", (e) => e.stopPropagation());
      body.appendChild(link);
    }

    li.appendChild(body);

    li.addEventListener("click", () => openModal(item.id));

    return li;
  }

  function toggleDone(id) {
    const item = state.items.find((it) => it.id === id);
    if (!item) return;

    // Marking a "to read" item as read is a meaningful moment — pause for a
    // short summary instead of silently checking it off.
    if (item.type === "read" && !item.done) {
      openSummaryPrompt(item);
      return;
    }

    item.done = !item.done;
    item.updatedAt = Date.now();
    saveItems(state.items);
    pushItemToServer(item);
    renderAll();
  }

  /* ---------------- Summary prompt (mark-as-read) ---------------- */
  function openSummaryPrompt(item) {
    state.summaryPromptId = item.id;
    els.summaryPromptTitle.textContent = item.title;
    els.summaryPromptText.value = item.summary || "";
    els.summaryPromptOverlay.hidden = false;
    document.body.style.overflow = "hidden";
    setTimeout(() => els.summaryPromptText.focus(), 50);
  }

  function closeSummaryPrompt() {
    els.summaryPromptOverlay.hidden = true;
    document.body.style.overflow = "";
    state.summaryPromptId = null;
  }

  function completeSummaryPrompt(withSummary) {
    const item = state.items.find((it) => it.id === state.summaryPromptId);
    if (!item) { closeSummaryPrompt(); return; }

    if (withSummary) {
      const text = els.summaryPromptText.value.trim();
      if (text) item.summary = text;
    }
    item.done = true;
    item.readAt = Date.now();
    item.updatedAt = Date.now();

    saveItems(state.items);
    pushItemToServer(item);
    closeSummaryPrompt();
    renderAll();
    showToast("읽은 기록에 저장했어요");
  }

  /* ---------------- Modal ---------------- */
  function renderColorPicker() {
    els.colorPicker.innerHTML = "";
    COLORS.forEach((c) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "color-swatch" + (state.modalColor === c.key ? " selected" : "");
      btn.style.background = c.value;
      btn.addEventListener("click", () => {
        state.modalColor = c.key;
        renderColorPicker();
      });
      els.colorPicker.appendChild(btn);
    });
  }

  function openModal(id, typeForNew) {
    state.editingId = id || null;
    const item = id ? state.items.find((it) => it.id === id) : null;
    const type = item ? item.type : (typeForNew || "todo");
    state.editingType = type;

    const isRead = type === "read";
    els.urlFieldWrap.hidden = !isRead;
    els.priorityFieldWrap.hidden = isRead;
    els.summaryFieldWrap.hidden = !isRead;

    els.modalTitle.textContent = item ? (isRead ? "읽을거리 수정" : "일정 수정") : (isRead ? "새 읽을거리" : "새 일정");
    els.fieldTitle.placeholder = isRead ? "예: 좋은 마케팅 아티클" : "예: 팀 회의";
    els.fieldTitle.value = item ? item.title : "";
    els.fieldUrl.value = item ? (item.url || "") : "";
    els.fieldSummary.value = item ? (item.summary || "") : "";
    els.fieldDate.value = item ? (item.date || "") : (!isRead && state.currentView === "calendarView" ? state.selectedDateKey : "");
    els.fieldTime.value = item ? (item.time || "") : "";
    els.fieldMemo.value = item ? (item.memo || "") : "";
    els.fieldImportant.checked = item ? !!item.important : false;
    els.fieldUrgent.checked = item ? !!item.urgent : false;
    els.fieldRemind.checked = item ? !!item.remindEnabled : false;
    state.modalColor = item ? item.color : COLORS[0].key;
    renderColorPicker();

    if (item) {
      els.doneFieldWrap.hidden = false;
      els.fieldDone.checked = !!item.done;
      els.fieldDoneLabel.textContent = isRead ? "다 읽음" : "완료됨";
      els.deleteBtn.hidden = false;
    } else {
      els.doneFieldWrap.hidden = true;
      els.fieldDone.checked = false;
      els.deleteBtn.hidden = true;
    }

    els.modalOverlay.hidden = false;
    document.body.style.overflow = "hidden";
    setTimeout(() => els.fieldTitle.focus(), 50);
  }

  function closeModal() {
    els.modalOverlay.hidden = true;
    document.body.style.overflow = "";
    state.editingId = null;
  }

  function handleSubmit(e) {
    e.preventDefault();
    const type = state.editingType;
    const isRead = type === "read";
    const title = els.fieldTitle.value.trim();
    if (!title) {
      els.fieldTitle.focus();
      return;
    }

    const remindEnabled = els.fieldRemind.checked;
    const date = els.fieldDate.value || null;
    const time = els.fieldTime.value || null;
    if (remindEnabled && (!date || !time)) {
      showToast("알림을 받으려면 날짜와 시간을 입력해주세요");
      return;
    }
    const remindAt = remindEnabled && date && time ? new Date(`${date}T${time}:00`).toISOString() : null;

    const payload = {
      type,
      title,
      url: isRead ? els.fieldUrl.value.trim() : "",
      date,
      time,
      memo: els.fieldMemo.value.trim(),
      summary: isRead ? els.fieldSummary.value.trim() : "",
      color: state.modalColor,
      important: isRead ? false : els.fieldImportant.checked,
      urgent: isRead ? false : els.fieldUrgent.checked,
      remindEnabled,
      remindAt
    };

    let savedItem;
    if (state.editingId) {
      const item = state.items.find((it) => it.id === state.editingId);
      const wasDone = item.done;
      const nowDone = els.fieldDone.checked;
      Object.assign(item, payload, { done: nowDone, updatedAt: Date.now() });
      if (isRead && nowDone && !wasDone) item.readAt = Date.now();
      savedItem = item;
      showToast("수정되었습니다");
    } else {
      savedItem = Object.assign({ id: uid(), done: false, createdAt: Date.now(), updatedAt: Date.now() }, payload);
      state.items.push(savedItem);
      showToast(isRead ? "읽을거리가 추가되었습니다" : "일정이 추가되었습니다");
    }

    saveItems(state.items);
    closeModal();
    renderAll();
    pushItemToServer(savedItem);

    if (remindEnabled && remindAt) {
      ensurePushSubscribed().then((ok) => {
        if (!ok) showToast("알림 없이 저장했어요");
      });
    }
  }

  function handleDelete() {
    if (!state.editingId) return;
    if (!confirm("삭제할까요?")) return;
    const item = state.items.find((it) => it.id === state.editingId);
    if (!item) return;
    // Soft delete: keeps a tombstone so the deletion correctly propagates
    // to other paired devices instead of a stale copy reappearing there.
    item.deleted = true;
    item.updatedAt = Date.now();
    saveItems(state.items);
    pushItemToServer(item);
    showToast("삭제되었습니다");
    closeModal();
    renderAll();
  }

  /* ---------------- Toast ---------------- */
  let toastTimer = null;
  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 1800);
  }

  /* ---------------- Tabs ---------------- */
  function switchView(viewId) {
    state.currentView = viewId;
    Object.entries(els.views).forEach(([id, el]) => { el.hidden = id !== viewId; });
    els.tabBtns.forEach((btn) => btn.classList.toggle("active", btn.dataset.view === viewId));
    if (viewId === "matrixView") renderMatrix();
    if (viewId === "calendarView") { renderCalendar(); renderDayDetail(); }
    if (viewId === "readView") renderReadList();
  }

  /* ---------------- Render all ---------------- */
  function renderAll() {
    renderCalendar();
    renderDayDetail();
    renderMatrix();
    renderReadList();
  }

  /* ---------------- Event wiring ---------------- */
  els.prevMonthBtn.addEventListener("click", () => {
    state.currentMonth = addMonths(state.currentMonth, -1);
    renderCalendar();
  });
  els.nextMonthBtn.addEventListener("click", () => {
    state.currentMonth = addMonths(state.currentMonth, 1);
    renderCalendar();
  });
  els.todayBtn.addEventListener("click", () => {
    const now = new Date();
    state.currentMonth = startOfMonth(now);
    state.selectedDateKey = dateKey(now);
    if (state.currentView !== "calendarView") switchView("calendarView");
    else { renderCalendar(); renderDayDetail(); }
  });

  els.tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  els.addBtn.addEventListener("click", () => {
    openModal(null, state.currentView === "readView" ? "read" : "todo");
  });
  els.cancelBtn.addEventListener("click", closeModal);
  els.deleteBtn.addEventListener("click", handleDelete);
  els.itemForm.addEventListener("submit", handleSubmit);
  els.modalOverlay.addEventListener("click", (e) => {
    if (e.target === els.modalOverlay) closeModal();
  });

  els.exportReadBtn.addEventListener("click", exportReadArchive);

  els.summarySaveBtn.addEventListener("click", () => completeSummaryPrompt(true));
  els.summarySkipBtn.addEventListener("click", () => completeSummaryPrompt(false));
  els.summaryCancelBtn.addEventListener("click", closeSummaryPrompt);
  els.summaryPromptOverlay.addEventListener("click", (e) => {
    if (e.target === els.summaryPromptOverlay) closeSummaryPrompt();
  });

  els.showDoneToggle.checked = state.settings.showDone;
  els.showDoneToggle.addEventListener("change", () => {
    state.settings.showDone = els.showDoneToggle.checked;
    saveSettings(state.settings);
    renderMatrix();
  });

  /* ---------------- Notification settings modal ---------------- */
  async function refreshNotifyStatus() {
    if (!pushSupported()) {
      els.notifyStatus.textContent = "이 브라우저/기기는 웹 푸시 알림을 지원하지 않아요.";
      els.notifyEnableBtn.hidden = true;
      return;
    }
    if (Notification.permission === "denied") {
      els.notifyStatus.textContent = "알림이 차단되어 있어요. 기기 설정에서 이 앱의 알림을 허용해주세요.";
      els.notifyEnableBtn.hidden = true;
      return;
    }
    const sub = await getExistingSubscription();
    if (sub) {
      els.notifyStatus.textContent = "알림이 켜져 있어요. 🔔 알림 받기를 설정한 일정/읽을거리가 제시간에 도착해요.";
      els.notifyEnableBtn.hidden = true;
    } else {
      els.notifyStatus.textContent = "아직 알림이 꺼져 있어요. 버튼을 눌러 켜주세요.";
      els.notifyEnableBtn.hidden = false;
    }
  }

  els.notifyBtn.addEventListener("click", () => {
    els.notifyModalOverlay.hidden = false;
    refreshNotifyStatus();
  });
  els.notifyCloseBtn.addEventListener("click", () => { els.notifyModalOverlay.hidden = true; });
  els.notifyModalOverlay.addEventListener("click", (e) => {
    if (e.target === els.notifyModalOverlay) els.notifyModalOverlay.hidden = true;
  });
  els.notifyEnableBtn.addEventListener("click", async () => {
    const ok = await ensurePushSubscribed();
    if (ok) showToast("알림이 켜졌어요");
    refreshNotifyStatus();
  });
  els.notifyTestBtn.addEventListener("click", async () => {
    const ok = await ensurePushSubscribed();
    if (!ok) return;
    fetch("/.netlify/functions/send-test-push", {
      method: "POST",
      headers: { "X-Sync-Code": getSyncCode() }
    })
      .then((res) => {
        if (res.ok) showToast("테스트 알림을 보냈어요. 잠시 후 확인해보세요");
        else showToast("테스트 알림 전송에 실패했어요");
      })
      .catch(() => showToast("배포된 주소에서만 테스트할 수 있어요"));
  });

  /* ---------------- Sync / pairing modal ---------------- */
  function formatSyncTime(ms) {
    if (!ms) return "";
    const diffSec = Math.round((Date.now() - ms) / 1000);
    if (diffSec < 10) return "방금 전";
    if (diffSec < 60) return `${diffSec}초 전`;
    if (diffSec < 3600) return `${Math.round(diffSec / 60)}분 전`;
    return `${Math.round(diffSec / 3600)}시간 전`;
  }

  function refreshSyncStatus() {
    const code = getSyncCode();
    if (code) {
      els.syncPairForm.hidden = true;
      els.syncConnectedInfo.hidden = false;
      els.syncStatus.textContent = state.lastSyncAt
        ? `✅ 연결됨 · 마지막 동기화: ${formatSyncTime(state.lastSyncAt)}`
        : "✅ 연결됨 · 동기화 대기 중";
    } else {
      els.syncPairForm.hidden = false;
      els.syncConnectedInfo.hidden = true;
      els.syncStatus.textContent = "아직 다른 기기와 연결되지 않았어요. 이 기기에만 저장돼요.";
      els.syncCodeInput.value = "";
    }
  }

  els.syncBtn.addEventListener("click", () => {
    els.syncModalOverlay.hidden = false;
    refreshSyncStatus();
  });
  els.syncCloseBtn.addEventListener("click", () => { els.syncModalOverlay.hidden = true; });
  els.syncModalOverlay.addEventListener("click", (e) => {
    if (e.target === els.syncModalOverlay) els.syncModalOverlay.hidden = true;
  });

  els.syncConnectBtn.addEventListener("click", async () => {
    const code = els.syncCodeInput.value.trim();
    if (!code) {
      showToast("동기화 코드를 입력해주세요");
      return;
    }
    els.syncStatus.textContent = "연결을 확인하는 중...";
    try {
      const res = await fetch("/.netlify/functions/sync-items", { headers: { "X-Sync-Code": code } });
      if (res.status === 401) {
        showToast("코드가 올바르지 않아요");
        refreshSyncStatus();
        return;
      }
      if (!res.ok) {
        showToast("연결에 실패했어요. 잠시 후 다시 시도해주세요");
        refreshSyncStatus();
        return;
      }
      setSyncCode(code);
      const data = await res.json();
      mergeServerItems(data.items || []);
      state.lastSyncAt = Date.now();
      renderAll();
      refreshSyncStatus();
      showToast("기기가 연결됐어요");
    } catch (err) {
      showToast("배포된 주소(https)에서만 연결할 수 있어요");
      refreshSyncStatus();
    }
  });

  els.syncDisconnectBtn.addEventListener("click", () => {
    clearSyncCode();
    state.lastSyncAt = null;
    refreshSyncStatus();
    showToast("연결을 해제했어요. 이 기기에만 저장돼요");
  });

  /* ---------------- Init ---------------- */
  renderAll();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((err) => console.warn("SW registration failed", err));
    });
  }

  if (getSyncCode()) {
    pullFromServer();
    setInterval(() => pullFromServer(), 25000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) pullFromServer();
    });
    window.addEventListener("focus", () => pullFromServer());
  }
})();
