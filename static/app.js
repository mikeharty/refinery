// Refinery - A staged reference evaluation tool for TTS models, built on top of Fish-Speech.
// (c) 2026 Mike Harty, licensed under MIT

const bootDataEl = document.getElementById("boot-data");
const BOOT = bootDataEl?.textContent
  ? JSON.parse(bootDataEl.textContent)
  : window.BOOT || {};
const DEFAULT_TTS_SETTINGS = structuredClone(BOOT.defaultSettings || {});
const MODEL_PRESETS = {
  default: {},
  cartoon: {
    temperature: 0.8,
    top_p: 0.85,
    repetition_penalty: 1.1,
    chunk_length: 250,
    max_new_tokens: 1024,
    latency: "normal",
    normalize: true,
    condition_on_previous_chunks: true,
    prosody: {
      speed: 1.04,
      volume: 1,
      normalize_loudness: true,
    },
  },
  speech: {
    temperature: 0.55,
    top_p: 0.6,
    repetition_penalty: 1.25,
    chunk_length: 300,
    max_new_tokens: 1280,
    latency: "normal",
    normalize: true,
    condition_on_previous_chunks: true,
    prosody: {
      speed: 0.95,
      volume: 0,
      normalize_loudness: true,
    },
  },
  singing: {
    temperature: 0.9,
    top_p: 0.9,
    repetition_penalty: 1.05,
    chunk_length: 300,
    max_new_tokens: 1536,
    latency: "normal",
    normalize: false,
    condition_on_previous_chunks: true,
    prosody: {
      speed: 1,
      volume: 0,
      normalize_loudness: false,
    },
  },
};
const MODEL_PRESET_KEYS = Object.freeze(Object.keys(MODEL_PRESETS));
const SETTINGS_RANGE_IDS = new Set([
  "temperature",
  "top_p",
  "repetition_penalty",
  "speed",
  "volume",
  "chunk_length",
  "max_new_tokens",
]);
const SETTINGS_CONTROL_IDS = Object.freeze([
  "model",
  "latency",
  ...SETTINGS_RANGE_IDS,
  "normalize",
  "condition_on_previous_chunks",
  "normalize_loudness",
]);
const TWO_DECIMAL_SETTING_IDS = new Set([
  "temperature",
  "top_p",
  "repetition_penalty",
  "speed",
]);
let applyingSettings = false;

// ─── State ────────────────────────────────────────────────

const state = {
  voice: BOOT.voices?.[0] || "",
  config: { nRefs: 3, limit: 6 },
  texts: [],
  styles: [""],
  settings: structuredClone(DEFAULT_TTS_SETTINGS),
  round: null, // { id, voice, plans, settings, samples }
  ratings: new Map(), // cellKey -> -1 | 0 | 1
  audio: new Map(), // cellKey -> { status, blobUrl?, cacheState?, error? }
  players: new Map(), // cellKey -> WaveSurfer instance
  history: [], // [{ id, voice, plans, settings, ratings, ts, summary }]
  pinned: new Set(), // ref names hard-included in next gen
  excluded: new Set(), // ref names hard-excluded in next gen
  fish: { fish: "checking", url: "", kind: "" },
  ui: {
    fetchQueue: [],
    activeFetches: new Set(),
    fetchControllers: new Set(),
    audioRunId: 0,
    audioProgress: null,
    viewBy: "variant", // "variant" | "phrase" | "style"
    modelPreset: "default",
    refQuery: "",
    refPoolExpanded: false,
  },
  roundCounter: 0,
};

const WAVE_COLOR = "#50505e";
const PROGRESS_COLOR = "#5b8def";
const WAVE_HEIGHT = 28;

const STORAGE_KEY = "refinery:state:v1";
const VIEW_DEFAULT_MIGRATION_KEY = "refinery:view-default:variant:v1";
const DEFAULT_VIEW_BY = "variant";
const HISTORY_LIMIT = 12;
const CONFIRM_THRESHOLD = 50;
const REF_POOL_COLLAPSED_LIMIT = 24;
const MAX_TEXTS_PER_VARIANT = Math.max(1, Number(BOOT.maxTexts || 8));
let savePending = null;
let audioProgressTimer = null;

function loadPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn("loadPersisted", e);
    return null;
  }
}

function persistState() {
  if (savePending) clearTimeout(savePending);
  savePending = setTimeout(() => {
    try {
      const payload = {
        voice: state.voice,
        config: state.config,
        texts: state.texts,
        styles: state.styles,
        settings: state.settings,
        modelPreset: state.ui.modelPreset,
        viewBy: state.ui.viewBy,
        roundCounter: state.roundCounter,
        history: state.history || [],
        pinned: [...state.pinned],
        excluded: [...state.excluded],
        currentRound: state.round
          ? {
            id: state.round.id,
            voice: state.round.voice,
            plans: state.round.plans,
            settings: state.round.settings,
            ratings: Object.fromEntries(state.ratings),
          }
          : null,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn("persistState", e);
    }
  }, 200);
}

const TTS_CONCURRENCY = 3;

function cellKey(planId, sampleIndex) {
  return `${planId}::${sampleIndex}`;
}

// ─── DOM refs ─────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const voiceEl = $("voice");
const nRefsEl = $("n_refs");
const limitEl = $("limit");
const renderEstimateEl = $("render-estimate");
const poolInfoEl = $("pool-info");
const roundInfoEl = $("round-info");
const refFilterEl = $("ref-filter");
const refPoolToggleEl = $("ref-pool-toggle");
const refPoolSummaryEl = $("ref-pool-summary");
const modelPresetEl = $("model-preset");
const textsContainer = $("texts-container");
const textsSelectionMetaEl = $("texts-selection-meta");
const textsDirtyIndicatorEl = $("texts-dirty-indicator");
const selectAllTextsBtn = $("select-all-texts");
const selectNoneTextsBtn = $("select-none-texts");
const stylesContainer = $("styles-container");
const variantsEl = $("variants");
const canvasHeaderEl = $("canvas-header");
const canvasStatusEl = $("canvas-status");
const canvasStatusBareEl = $("canvas-status-bare");
const generateBtn = $("generate");
const refineBtn = $("refine");
const saveWinnerBtn = $("save-winner");
const stopAllBtn = $("stop-all");
const resetSettingsBtn = $("reset-settings");
const resetTextsBtn = $("reset-texts");
const variantTpl = $("variant-tpl");
const cellTpl = $("cell-tpl");

// ─── Text/style management ────────────────────────────────

function findMoodKey(voiceName) {
  const data = BOOT.textsData;
  if (!data || Array.isArray(data)) return null;
  if (data[voiceName]) return voiceName;
  const lower = voiceName.toLowerCase();
  for (const k of Object.keys(data)) {
    if (lower.includes(k.toLowerCase())) return k;
  }
  for (const k of Object.keys(data)) {
    if (k.toLowerCase().includes(lower)) return k;
  }
  return null;
}

function textsForVoice(voiceName) {
  const data = BOOT.textsData;
  if (Array.isArray(data)) return data.slice();
  const key = findMoodKey(voiceName);
  if (key && Array.isArray(data[key])) return data[key].slice();
  for (const v of Object.values(data || {})) {
    if (Array.isArray(v) && v.length) return v.slice();
  }
  return [];
}

function clampTextSelection(entries) {
  let selected = 0;
  return entries.map((entry) => {
    const next = {
      value: entry?.value || "",
      selected: Boolean(entry?.selected),
    };
    if (next.selected) {
      if (selected >= MAX_TEXTS_PER_VARIANT) {
        next.selected = false;
      } else {
        selected += 1;
      }
    }
    return next;
  });
}

function normalizeTextEntries(raw) {
  if (!Array.isArray(raw)) return [];
  return clampTextSelection(
    raw
      .map((item) => {
        if (typeof item === "string") {
          return { value: item, selected: true };
        }
        if (!item || typeof item !== "object") {
          return null;
        }
        const value =
          typeof item.value === "string"
            ? item.value
            : typeof item.text === "string"
              ? item.text
              : "";
        return {
          value,
          selected: item.selected !== false,
        };
      })
      .filter(Boolean)
  );
}

function defaultTextEntries(voiceName) {
  const values = textsForVoice(voiceName);
  return normalizeTextEntries(
    (values.length ? values : [""]).map((value) => ({ value, selected: true }))
  );
}

function selectedTextCount() {
  return state.texts.filter((entry) => entry?.selected).length;
}

function updateTextsSelectionMeta() {
  if (!textsSelectionMetaEl) return;
  const selected = selectedTextCount();
  textsSelectionMetaEl.textContent = `${selected} / ${MAX_TEXTS_PER_VARIANT} selected`;
  textsSelectionMetaEl.classList.toggle("warn", selected >= MAX_TEXTS_PER_VARIANT);
}

function selectAllTexts() {
  let selected = 0;
  state.texts = state.texts.map((entry) => {
    const next = { ...entry, selected: selected < MAX_TEXTS_PER_VARIANT };
    if (next.selected) selected += 1;
    return next;
  });
  if (state.texts.length > MAX_TEXTS_PER_VARIANT) {
    setStatus(
      `Selected the first ${MAX_TEXTS_PER_VARIANT} phrases; that is the per-run limit.`
    );
  }
  renderTexts();
  updateCostUI();
}

function deselectAllTexts() {
  state.texts = state.texts.map((entry) => ({ ...entry, selected: false }));
  renderTexts();
  updateCostUI();
}

function setTextSelected(idx, checked, { preserveFocus = false } = {}) {
  if (
    checked &&
    !state.texts[idx].selected &&
    selectedTextCount() >= MAX_TEXTS_PER_VARIANT
  ) {
    setStatus(`Select up to ${MAX_TEXTS_PER_VARIANT} phrases per run.`, "error");
    renderTexts();
    updateCostUI();
    return false;
  }

  let selectionStart = null;
  let selectionEnd = null;
  if (preserveFocus) {
    const textarea = textsContainer.querySelectorAll("textarea")[idx];
    if (textarea) {
      selectionStart = textarea.selectionStart;
      selectionEnd = textarea.selectionEnd;
    }
  }

  state.texts[idx].selected = checked;
  renderTexts();
  updateCostUI();

  if (preserveFocus) {
    const nextTextarea = textsContainer.querySelectorAll("textarea")[idx];
    if (nextTextarea) {
      nextTextarea.focus();
      if (selectionStart !== null && selectionEnd !== null) {
        nextTextarea.setSelectionRange(selectionStart, selectionEnd);
      }
    }
  }
  return true;
}

function autoResize(ta) {
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
}

function makeEditorRow(
  value,
  placeholder,
  selectedOrOnChange,
  onToggleOrOnRemove,
  onChange,
  onRemove
) {
  const row = document.createElement("div");
  row.className = "rail-row";

  const selectable = typeof selectedOrOnChange !== "function";
  const selected = selectable ? Boolean(selectedOrOnChange) : true;
  const onToggle = selectable ? onToggleOrOnRemove : () => { };
  const handleChange = selectable ? onChange : selectedOrOnChange;
  const handleRemove = selectable ? onRemove : onToggleOrOnRemove;

  if (selectable) {
    row.classList.toggle("is-selected", selected);
    row.classList.toggle("is-unselected", !selected);
    row.title = selected ? "Selected for this run" : "Not selected for this run";
  }

  if (selectable) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "rail-row-select";
    toggle.title = selected ? "Selected for this run" : "Not selected for this run";
    toggle.setAttribute("aria-pressed", String(selected));
    toggle.setAttribute(
      "aria-label",
      selected ? "Selected for this run" : "Not selected for this run"
    );
    toggle.innerHTML = `
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M5 12.5l4.2 4.2L19 7" />
      </svg>
    `;
    toggle.addEventListener("click", () => onToggle(!selected));
    row.appendChild(toggle);
  }

  const ta = document.createElement("textarea");
  ta.rows = 1;
  ta.value = value || "";
  ta.placeholder = placeholder;
  ta.addEventListener("input", () => {
    autoResize(ta);
    handleChange(ta.value);
  });
  const remove = document.createElement("button");
  remove.className = "remove";
  remove.type = "button";
  remove.title = "Remove";
  remove.setAttribute("aria-label", "Remove row");
  remove.textContent = "×";
  remove.addEventListener("click", () => handleRemove());

  if (selectable) {
    row.addEventListener("click", (event) => {
      if (event.target.closest(".remove") || event.target.closest(".rail-row-select")) {
        return;
      }
      const clickedTextarea = event.target === ta;
      if (clickedTextarea && document.activeElement === ta) {
        return;
      }
      onToggle(!selected, { preserveFocus: clickedTextarea });
    });
  }

  row.append(ta, remove);
  requestAnimationFrame(() => autoResize(ta));
  return row;
}

function renderTexts() {
  textsContainer.innerHTML = "";
  state.texts.forEach((entry, idx) => {
    textsContainer.appendChild(
      makeEditorRow(
        entry.value,
        "Enter a test phrase…",
        entry.selected,
        (checked, options = {}) => setTextSelected(idx, checked, options),
        (val) => {
          state.texts[idx].value = val;
          updateCostUI();
        },
        () => {
          if (state.texts.length > 1) {
            state.texts.splice(idx, 1);
            renderTexts();
            updateCostUI();
          }
        }
      )
    );
  });
}

function textEntriesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if ((a[i]?.value || "") !== (b[i]?.value || "")) return false;
    if (Boolean(a[i]?.selected) !== Boolean(b[i]?.selected)) return false;
  }
  return true;
}

function currentTextDefaults() {
  return defaultTextEntries(state.voice);
}

function updateTextsDirtyIndicator() {
  if (!textsDirtyIndicatorEl) return;
  const current = state.texts.length ? state.texts : defaultTextEntries(state.voice);
  const defaults = currentTextDefaults();
  const dirty = !textEntriesEqual(current, defaults);
  textsDirtyIndicatorEl.hidden = !dirty;
  textsDirtyIndicatorEl.title = dirty
    ? "These phrases differ from the current defaults for this voice. Reset phrases to reload them from texts.json."
    : "";
}

function renderStyles() {
  stylesContainer.innerHTML = "";
  state.styles.forEach((s, idx) => {
    stylesContainer.appendChild(
      makeEditorRow(
        s,
        "Baseline or [style tag]",
        (val) => {
          state.styles[idx] = val;
          updateCostUI();
        },
        () => {
          if (state.styles.length > 1) {
            state.styles.splice(idx, 1);
            renderStyles();
            updateCostUI();
          }
        }
      )
    );
  });
}

// ─── Cost / estimate UI ───────────────────────────────────

function effectiveStyles() {
  const out = [];
  const seen = new Set();
  for (const s of state.styles) {
    const trimmed = (s || "").trim();
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    if (trimmed || out.length === 0) {
      out.push(trimmed);
      seen.add(key);
    }
  }
  return out.length ? out : [""];
}

function effectiveTexts() {
  return state.texts
    .filter((entry) => entry?.selected)
    .map((entry) => (entry?.value || "").trim())
    .filter(Boolean);
}

function renderCount() {
  const texts = effectiveTexts().length || 0;
  const styles = effectiveStyles().length || 1;
  return state.config.limit * Math.max(1, texts) * Math.max(1, styles);
}

function updateCostUI() {
  const n = renderCount();
  renderEstimateEl.textContent = `${n} render${n === 1 ? "" : "s"}`;
  renderEstimateEl.parentElement.classList.toggle("over", n >= 50);
  updateTextsSelectionMeta();
  updateTextsDirtyIndicator();
  persistState();
}

// ─── Settings binding ─────────────────────────────────────

function cloneSettings(settings = DEFAULT_TTS_SETTINGS) {
  return structuredClone(settings || {});
}

function mergeSettings(base, patch = {}) {
  const merged = { ...cloneSettings(base), ...(patch || {}) };
  merged.prosody = {
    ...(base?.prosody || {}),
    ...(patch?.prosody || {}),
  };
  return merged;
}

function settingsForPreset(key) {
  return mergeSettings(
    DEFAULT_TTS_SETTINGS,
    MODEL_PRESETS[key] || MODEL_PRESETS.default
  );
}

function formatSettingValue(id, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? "");
  return TWO_DECIMAL_SETTING_IDS.has(id) ? n.toFixed(2) : String(n);
}

function refreshRangeOutput(id) {
  const input = $(id);
  const output = $(`${id}_val`);
  if (!input || !output) return;
  output.textContent = formatSettingValue(id, input.value);
}

function flatSettings(settings) {
  return {
    model: settings.model,
    latency: settings.latency,
    temperature: settings.temperature,
    top_p: settings.top_p,
    repetition_penalty: settings.repetition_penalty,
    chunk_length: settings.chunk_length,
    max_new_tokens: settings.max_new_tokens,
    normalize: settings.normalize,
    condition_on_previous_chunks: settings.condition_on_previous_chunks,
    speed: settings.prosody?.speed,
    volume: settings.prosody?.volume,
    normalize_loudness: settings.prosody?.normalize_loudness,
  };
}

function settingsEqual(a, b) {
  const left = flatSettings(a);
  const right = flatSettings(b);
  return Object.keys(left).every((key) => {
    if (typeof left[key] === "number" || typeof right[key] === "number") {
      return Math.abs(Number(left[key]) - Number(right[key])) < 0.001;
    }
    return left[key] === right[key];
  });
}

function inferModelPreset(settings) {
  for (const key of MODEL_PRESET_KEYS) {
    if (settingsEqual(settings, settingsForPreset(key))) return key;
  }
  return "custom";
}

function setPresetUI(key) {
  if (!modelPresetEl) return;
  modelPresetEl.value = MODEL_PRESET_KEYS.includes(key) ? key : "custom";
}

function bindRange(id, formatter, onChange) {
  const input = $(id);
  const output = $(`${id}_val`);
  if (!input || !output) return;
  const update = () => {
    output.textContent = formatter(input.value);
    onChange?.(input.value);
  };
  input.addEventListener("input", update);
  update();
}

function applySettingsToControls(settings, { presetKey = null, persist = false } = {}) {
  const d = mergeSettings(DEFAULT_TTS_SETTINGS, settings);
  const setVal = (id, value) => {
    const el = $(id);
    if (el && value != null) el.value = value;
  };
  const setChk = (id, value) => {
    const el = $(id);
    if (el) el.checked = Boolean(value);
  };
  const knownPreset =
    presetKey && (MODEL_PRESET_KEYS.includes(presetKey) || presetKey === "custom");
  applyingSettings = true;
  try {
    setVal("model", d.model);
    setVal("latency", d.latency);
    setVal("temperature", d.temperature);
    setVal("top_p", d.top_p);
    setVal("repetition_penalty", d.repetition_penalty);
    setVal("chunk_length", d.chunk_length);
    setVal("max_new_tokens", d.max_new_tokens);
    setVal("speed", d.prosody?.speed);
    setVal("volume", d.prosody?.volume);
    setChk("normalize", d.normalize);
    setChk("condition_on_previous_chunks", d.condition_on_previous_chunks);
    setChk("normalize_loudness", d.prosody?.normalize_loudness);
    SETTINGS_RANGE_IDS.forEach(refreshRangeOutput);
    state.settings = readSettings();
    state.ui.modelPreset = knownPreset ? presetKey : inferModelPreset(state.settings);
    setPresetUI(state.ui.modelPreset);
  } finally {
    applyingSettings = false;
  }
  if (persist) persistState();
}

function syncSettingsFromControls({ presetKey = "custom" } = {}) {
  if (applyingSettings) return;
  state.settings = readSettings();
  state.ui.modelPreset = presetKey || inferModelPreset(state.settings);
  setPresetUI(state.ui.modelPreset);
  persistState();
}

function bindSettingsControls() {
  SETTINGS_CONTROL_IDS.forEach((id) => {
    const el = $(id);
    if (!el) return;
    const eventName = el.type === "range" ? "input" : "change";
    el.addEventListener(eventName, () =>
      syncSettingsFromControls({ presetKey: "custom" })
    );
  });
}

function readSettings() {
  return {
    model: $("model").value,
    latency: $("latency").value,
    temperature: Number($("temperature").value),
    top_p: Number($("top_p").value),
    repetition_penalty: Number($("repetition_penalty").value),
    chunk_length: Number($("chunk_length").value),
    max_new_tokens: Number($("max_new_tokens").value),
    normalize: $("normalize").checked,
    condition_on_previous_chunks: $("condition_on_previous_chunks").checked,
    prosody: {
      speed: Number($("speed").value),
      volume: Number($("volume").value),
      normalize_loudness: $("normalize_loudness").checked,
    },
  };
}

// ─── Voice pool ───────────────────────────────────────────

function updatePoolInfo() {
  const refs = BOOT.voiceRefs?.[state.voice] || [];
  poolInfoEl.textContent = `${refs.length} ref${refs.length === 1 ? "" : "s"} available`;
}

function renderRefPool() {
  const poolEl = $("ref-pool");
  if (!poolEl) return;
  poolEl.innerHTML = "";
  const refs = BOOT.voiceRefs?.[state.voice] || [];
  if (refFilterEl && refFilterEl.value !== state.ui.refQuery) {
    refFilterEl.value = state.ui.refQuery;
  }
  const scores = computeRefScores();
  // Sort: pinned first, then positive desc, then unrated, then negative, then excluded last
  const sortKey = (name) => {
    if (state.pinned.has(name)) return -1000 + name.localeCompare("");
    if (state.excluded.has(name)) return 1000 + name.localeCompare("");
    return -(scores[name] || 0);
  };
  const sorted = refs.slice().sort((a, b) => {
    const ka = sortKey(a),
      kb = sortKey(b);
    if (ka !== kb) return ka - kb;
    return a.localeCompare(b);
  });
  const query = state.ui.refQuery.trim().toLowerCase();
  const filtered = query
    ? sorted.filter((name) => name.toLowerCase().includes(query))
    : sorted;
  const shouldCollapse =
    !state.ui.refPoolExpanded && !query && filtered.length > REF_POOL_COLLAPSED_LIMIT;
  const visible = shouldCollapse
    ? filtered.slice(0, REF_POOL_COLLAPSED_LIMIT)
    : filtered;
  for (const name of visible) {
    const score = scores[name] || 0;
    const isPinned = state.pinned.has(name);
    const isExcluded = state.excluded.has(name);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "pool-row";
    if (isPinned) row.classList.add("pinned");
    else if (isExcluded) row.classList.add("excluded");
    if (score > 0) row.classList.add("scored-good");
    else if (score < 0) row.classList.add("scored-bad");
    else row.classList.add("unrated");
    const icon = isPinned
      ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2z"/></svg>`
      : isExcluded
        ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M5.5 18.5l13-13"/></svg>`
        : `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
    row.innerHTML = `
      <span class="pool-icon">${icon}</span>
      <span class="pool-name" title="${escapeHTML(name)}">${escapeHTML(name)}</span>
      <span class="pool-score">${score > 0 ? "+" + score : score}</span>
    `;
    row.dataset.refName = name;
    row.addEventListener("click", (e) => {
      if (e.shiftKey) {
        togglePin(name);
        return;
      }
      if (e.altKey) {
        toggleExclude(name);
        return;
      }
      previewRef(name);
      poolEl
        .querySelectorAll(".pool-row.playing")
        .forEach((r) => r.classList.remove("playing"));
      row.classList.add("playing");
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      togglePin(name);
    });
    poolEl.appendChild(row);
  }
  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "pool-empty";
    empty.textContent = query ? "No matching refs" : "No refs";
    poolEl.appendChild(empty);
  }
  if (refPoolSummaryEl) {
    const total = refs.length;
    const showing = visible.length;
    const label = query
      ? `${showing} match${showing === 1 ? "" : "es"} of ${total}`
      : shouldCollapse
        ? `Showing ${showing} of ${total}`
        : `${total} ref${total === 1 ? "" : "s"}`;
    refPoolSummaryEl.textContent = label;
  }
  if (refPoolToggleEl) {
    const canToggle = !query && refs.length > REF_POOL_COLLAPSED_LIMIT;
    refPoolToggleEl.hidden = !canToggle;
    refPoolToggleEl.textContent = state.ui.refPoolExpanded ? "Show top" : "Show all";
  }
  // Summary
  const positives = Object.values(scores).filter((v) => v > 0).length;
  const negatives = Object.values(scores).filter((v) => v < 0).length;
  const summaryEl = $("leaderboard-summary");
  if (summaryEl) {
    const parts = [];
    if (positives) parts.push(`${positives}↑`);
    if (negatives) parts.push(`${negatives}↓`);
    if (state.pinned.size) parts.push(`${state.pinned.size}📌`);
    if (state.excluded.size) parts.push(`${state.excluded.size}🚫`);
    summaryEl.textContent = parts.length ? parts.join(" ") : "no ratings";
  }
}

function togglePin(name) {
  if (state.excluded.has(name)) state.excluded.delete(name);
  if (state.pinned.has(name)) state.pinned.delete(name);
  else state.pinned.add(name);
  renderRefPool();
  persistState();
}

function toggleExclude(name) {
  if (state.pinned.has(name)) state.pinned.delete(name);
  if (state.excluded.has(name)) state.excluded.delete(name);
  else state.excluded.add(name);
  renderRefPool();
  persistState();
}

// ─── Refinement: aggregate ratings → ref scores ───────────

function computeRefScores() {
  if (!state.round) return {};
  const scores = {};
  for (const plan of state.round.plans) {
    let variantScore = 0;
    let n = 0;
    for (let s = 0; s < plan.samples.length; s++) {
      const r = state.ratings.get(cellKey(plan.id, s));
      if (r === 1 || r === -1) {
        variantScore += r;
        n += 1;
      }
    }
    if (n === 0) continue;
    for (const refName of plan.ref_names) {
      scores[refName] = (scores[refName] || 0) + variantScore;
    }
  }
  return scores;
}

function variantScore(plan) {
  let total = 0;
  for (let s = 0; s < plan.samples.length; s++) {
    const r = state.ratings.get(cellKey(plan.id, s));
    if (r === 1 || r === -1) total += r;
  }
  return total;
}

function anyRatings() {
  for (const v of state.ratings.values()) if (v !== 0) return true;
  return false;
}

function anyGoodRatings() {
  for (const v of state.ratings.values()) if (v > 0) return true;
  return false;
}

function refreshRoundUI() {
  const hasRound = Boolean(state.round);
  const ok = fishOk();
  generateBtn.disabled = !ok;
  refineBtn.disabled = !ok || !hasRound || !anyRatings();
  saveWinnerBtn.disabled = !hasRound || !anyGoodRatings();
  generateBtn.title = ok ? "Generate (G)" : "Fish-Speech is offline";
  refineBtn.title = ok ? "Refine from ratings (R)" : "Fish-Speech is offline";
  if (hasRound) {
    const round = state.round;
    roundInfoEl.innerHTML = `<span class="round-label">Round ${state.roundCounter}</span><span class="round-sub">${round.plans.length} variants · ${round.plans[0]?.samples?.length || 0} samples each</span>`;
  } else {
    roundInfoEl.innerHTML = `<span class="round-label">No round yet</span>`;
  }
  refreshStopAllUI();
}

// ─── Concurrency-limited fetch queue ──────────────────────

const STOPPABLE_AUDIO_STATUSES = new Set(["queued", "loading"]);

function hasStoppableAudioFetches() {
  for (const entry of state.audio.values()) {
    if (entry && STOPPABLE_AUDIO_STATUSES.has(entry.status)) return true;
  }
  return false;
}

function refreshStopAllUI() {
  if (!stopAllBtn) return;
  const active = hasStoppableAudioFetches();
  stopAllBtn.hidden = !active;
  stopAllBtn.disabled = !active;
}

function queueAudioFetch(task) {
  state.ui.fetchQueue.push({ runId: state.ui.audioRunId, task });
  refreshStopAllUI();
  pumpFetchQueue();
}

function pumpFetchQueue() {
  while (
    state.ui.activeFetches.size < TTS_CONCURRENCY &&
    state.ui.fetchQueue.length > 0
  ) {
    const item = state.ui.fetchQueue.shift();
    if (item.runId !== state.ui.audioRunId) continue;
    const token = Symbol("audio-fetch");
    state.ui.activeFetches.add(token);
    refreshStopAllUI();
    item
      .task()
      .catch(() => { })
      .finally(() => {
        state.ui.activeFetches.delete(token);
        updateAudioProgressStatus();
        refreshStopAllUI();
        pumpFetchQueue();
      });
  }
}

function abortAudioFetches() {
  stopAudioProgress({ clearStatus: false });
  state.ui.fetchQueue.length = 0;
  for (const controller of state.ui.fetchControllers) {
    controller.abort();
  }
  state.ui.fetchControllers.clear();
  state.ui.activeFetches.clear();
  state.ui.audioRunId += 1;
  refreshStopAllUI();
}

function stopAllGeneration({ silent = false } = {}) {
  let stopped = 0;
  state.ui.fetchQueue.length = 0;
  for (const [key, entry] of state.audio) {
    if (!entry || !STOPPABLE_AUDIO_STATUSES.has(entry.status)) continue;
    stopped += 1;
    state.audio.set(key, {
      ...entry,
      status: "stopped",
      endedAt: performance.now(),
    });
    const [planIdStr, sampleIndexStr] = key.split("::");
    updateCellStatus(Number(planIdStr), Number(sampleIndexStr));
  }
  for (const controller of state.ui.fetchControllers) {
    controller.abort("stopped");
  }
  state.ui.fetchControllers.clear();
  state.ui.activeFetches.clear();
  state.ui.audioRunId += 1;
  stopAudioProgress({ clearStatus: false });
  for (const player of state.players.values()) {
    if (player?.isPlaying?.()) player.pause();
  }
  refreshStopAllUI();
  if (!silent) {
    setStatus(
      stopped ? `Stopped ${stopped} pending render${stopped === 1 ? "" : "s"}.` : ""
    );
  }
}

// ─── Generate / refine ────────────────────────────────────

async function generate(options = {}) {
  const { refining = false } = options;
  state.settings = readSettings();

  // Snapshot ratings BEFORE we wipe the round, in case refining
  const refScores = refining ? computeRefScores() : {};

  const payload = {
    voice: state.voice,
    n_refs: state.config.nRefs,
    limit: state.config.limit,
    texts: effectiveTexts(),
    styles: effectiveStyles(),
    settings: state.settings,
    ref_scores: refScores,
    pinned: [...state.pinned],
    excluded: [...state.excluded],
  };

  if (payload.texts.length === 0) {
    setStatus("Add at least one test phrase first.", "error");
    return;
  }
  if (payload.texts.length > MAX_TEXTS_PER_VARIANT) {
    setStatus(`Select up to ${MAX_TEXTS_PER_VARIANT} phrases per run.`, "error");
    return;
  }

  const n = renderCount();
  if (usesHostedFishAudio() && n >= CONFIRM_THRESHOLD) {
    const proceed = confirm(
      `This run will make ${n} TTS calls.\n\nIf your Fish endpoint is paid, that's real money. Cached renders are free, but the first time each (text × refs × settings) combo is rendered it's a real call.\n\nContinue?`
    );
    if (!proceed) return;
  }

  setStatus(`Generating ${n} render${n === 1 ? "" : "s"}…`);
  generateBtn.disabled = true;
  refineBtn.disabled = true;

  let resp;
  try {
    resp = await fetch("/api/variants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    setStatus("Request failed — is the server running?", "error");
    generateBtn.disabled = false;
    return;
  }
  if (!resp.ok) {
    setStatus(`Failed to generate (${resp.status}).`, "error");
    generateBtn.disabled = false;
    return;
  }
  const body = await resp.json();

  // Snapshot the round we're about to replace into history.
  if (state.round) {
    const ratingsSnap = Object.fromEntries(state.ratings);
    const positives = Object.values(ratingsSnap).filter((v) => v > 0).length;
    const negatives = Object.values(ratingsSnap).filter((v) => v < 0).length;
    state.history.unshift({
      id: state.round.id,
      voice: state.round.voice,
      plans: state.round.plans,
      settings: state.round.settings,
      ratings: ratingsSnap,
      ts: Date.now(),
      summary: { positives, negatives, variants: state.round.plans.length },
    });
    state.history = state.history.slice(0, HISTORY_LIMIT);
  }

  state.roundCounter += 1;
  state.round = {
    id: state.roundCounter,
    voice: body.voice,
    plans: body.plans,
    settings: body.settings,
  };
  state.ratings = new Map();
  abortAudioFetches();
  destroyPlayers();
  for (const [, entry] of state.audio) {
    if (entry?.blobUrl) URL.revokeObjectURL(entry.blobUrl);
  }
  state.audio = new Map();

  renderVariants();
  refreshRoundUI();
  renderRefPool();
  renderHistoryStrip();
  generateBtn.disabled = false;
  persistState();

  // Kick off audio fetches via queue
  startAudioProgress(state.round.id, totalAudioCells(body.plans));
  for (const plan of body.plans) {
    plan.samples.forEach((sample, s) => {
      const key = cellKey(plan.id, s);
      state.audio.set(key, { status: "queued" });
      updateCellStatus(plan.id, s);
      const ctx = {
        roundId: state.round.id,
        runId: state.ui.audioRunId,
        voice: state.round.voice,
        settings: state.round.settings,
      };
      queueAudioFetch(() => fetchAudio(plan, s, sample, ctx));
    });
  }
  updateAudioProgressStatus();
}

function setStatus(text, kind = "") {
  const cls = "canvas-status " + kind;
  if (canvasStatusEl) {
    canvasStatusEl.textContent = text || "";
    canvasStatusEl.className = cls;
  }
  if (canvasStatusBareEl) {
    canvasStatusBareEl.textContent = text || "";
    canvasStatusBareEl.className = cls;
  }
}

function totalAudioCells(plans) {
  return (plans || []).reduce((total, plan) => total + (plan.samples?.length || 0), 0);
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

function startAudioProgress(roundId, total, verb = "Rendering") {
  stopAudioProgress({ clearStatus: false });
  state.ui.audioProgress = {
    roundId,
    total,
    verb,
    startedAt: performance.now(),
  };
  audioProgressTimer = setInterval(() => {
    refreshLoadingCellStatuses();
    updateAudioProgressStatus();
  }, 1000);
  updateAudioProgressStatus();
}

function stopAudioProgress({ clearStatus = false } = {}) {
  if (audioProgressTimer) {
    clearInterval(audioProgressTimer);
    audioProgressTimer = null;
  }
  state.ui.audioProgress = null;
  if (clearStatus) setStatus("");
}

function summarizeAudioProgress() {
  const progress = state.ui.audioProgress;
  if (!progress || !state.round || state.round.id !== progress.roundId) return null;

  const summary = {
    total: progress.total || state.audio.size,
    queued: 0,
    loading: 0,
    ready: 0,
    cached: 0,
    error: 0,
    stopped: 0,
    completed: 0,
    remaining: 0,
    elapsedMs: performance.now() - progress.startedAt,
    etaMs: null,
  };

  for (const entry of state.audio.values()) {
    const status = entry?.status || "queued";
    if (status === "ready") summary.ready += 1;
    else if (status === "cached") summary.cached += 1;
    else if (status === "error") summary.error += 1;
    else if (status === "stopped") summary.stopped += 1;
    else if (status === "loading") summary.loading += 1;
    else summary.queued += 1;
  }

  summary.completed = summary.ready + summary.cached + summary.error + summary.stopped;
  summary.remaining = Math.max(0, summary.total - summary.completed);
  if (summary.ready > 0 && summary.remaining > 0) {
    const generatedPerMs = summary.ready / Math.max(summary.elapsedMs, 1);
    summary.etaMs = summary.remaining / generatedPerMs;
  }
  return summary;
}

function updateAudioProgressStatus() {
  const progress = state.ui.audioProgress;
  const summary = summarizeAudioProgress();
  if (!progress || !summary) return;

  if (summary.remaining <= 0) {
    const suffix = [
      summary.cached ? `${summary.cached} cached` : "",
      summary.error ? `${summary.error} failed` : "",
      summary.stopped ? `${summary.stopped} stopped` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    stopAudioProgress({ clearStatus: false });
    setStatus(
      `${progress.verb} complete: ${summary.completed}/${summary.total} in ${formatDurationMs(summary.elapsedMs)}${suffix ? ` · ${suffix}` : ""}`,
      summary.error ? "error" : "success"
    );
    return;
  }

  const parts = [
    `${progress.verb} ${summary.completed}/${summary.total}`,
    `${summary.loading} active`,
    `${summary.queued} queued`,
    summary.etaMs === null ? "ETA learning" : `ETA ${formatDurationMs(summary.etaMs)}`,
    `${formatDurationMs(summary.elapsedMs)} elapsed`,
  ];
  if (summary.cached) parts.push(`${summary.cached} cached`);
  if (summary.error) parts.push(`${summary.error} failed`);
  if (summary.stopped) parts.push(`${summary.stopped} stopped`);
  setStatus(parts.join(" · "));
  refreshStopAllUI();
}

function refreshLoadingCellStatuses() {
  for (const [key, entry] of state.audio) {
    if (entry?.status !== "loading") continue;
    const [planIdStr, sampleIndexStr] = key.split("::");
    updateCellStatus(Number(planIdStr), Number(sampleIndexStr));
  }
}

// ─── Audio fetch ──────────────────────────────────────────

function isAudioContextCurrent(ctx) {
  return state.round?.id === ctx.roundId && state.ui.audioRunId === ctx.runId;
}

async function fetchAudio(plan, sampleIndex, sample, ctx) {
  // ctx is captured at queue time so a new round started mid-flight can't
  // poison the in-flight fetches.
  const key = cellKey(plan.id, sampleIndex);
  // If we've moved past this round, drop the work silently.
  if (!isAudioContextCurrent(ctx)) return;

  const startedAt = performance.now();
  state.audio.set(key, { status: "loading", startedAt });
  updateCellStatus(plan.id, sampleIndex);
  updateAudioProgressStatus();

  const ac = new AbortController();
  state.ui.fetchControllers.add(ac);
  try {
    const resp = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voice: ctx.voice,
        refs: plan.ref_names,
        text: sample.text,
        settings: ctx.settings,
      }),
      signal: ac.signal,
    });
    if (!isAudioContextCurrent(ctx)) return;
    if (!resp.ok) {
      state.audio.set(key, {
        status: "error",
        error: `HTTP ${resp.status}`,
        startedAt,
        endedAt: performance.now(),
      });
      updateCellStatus(plan.id, sampleIndex);
      updateAudioProgressStatus();
      if (resp.status === 502 || resp.status === 504) checkFishHealth({ silent: true });
      return;
    }
    const blob = await resp.blob();
    if (!isAudioContextCurrent(ctx)) return;
    const url = URL.createObjectURL(blob);
    const cacheState = resp.headers.get("x-refinery-cache");
    state.audio.set(key, {
      status: cacheState === "hit" ? "cached" : "ready",
      blobUrl: url,
      cacheState,
      startedAt,
      endedAt: performance.now(),
    });
    updateCellAudio(plan.id, sampleIndex);
    updateAudioProgressStatus();
  } catch (err) {
    if (!isAudioContextCurrent(ctx)) return;
    const stopped = ac.signal.aborted && ac.signal.reason === "stopped";
    state.audio.set(
      key,
      stopped
        ? {
          status: "stopped",
          startedAt,
          endedAt: performance.now(),
        }
        : {
          status: "error",
          error: err.name === "AbortError" ? "cancelled" : "error",
          startedAt,
          endedAt: performance.now(),
        }
    );
    updateCellStatus(plan.id, sampleIndex);
    updateAudioProgressStatus();
  } finally {
    state.ui.fetchControllers.delete(ac);
    refreshStopAllUI();
  }
}

// ─── Render variants ──────────────────────────────────────

function renderVariants() {
  variantsEl.innerHTML = "";
  destroyPlayers();
  if (!state.round) {
    if (canvasHeaderEl) canvasHeaderEl.hidden = true;
    canvasStatusBareEl.hidden = false;
    const empty = document.createElement("div");
    empty.className = "canvas-empty";
    empty.innerHTML = `
      <div>
        <img src="/static/icon.svg?v=cell" alt="" class="canvas-empty-icon">
        <h3>No variants yet</h3>
        <p>Configure refs, phrases, and (optional) styles in the left rail. Press <kbd>G</kbd> to generate a round; <kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> to rate the focused cell; <kbd>R</kbd> to refine; <kbd>S</kbd> to save.</p>
      </div>
    `;
    variantsEl.appendChild(empty);
    return;
  }

  if (canvasHeaderEl) canvasHeaderEl.hidden = false;
  canvasStatusBareEl.hidden = true;

  const view = state.ui.viewBy;
  if (view === "variant") renderByVariant();
  else if (view === "phrase") renderByPhrase();
  else if (view === "style") renderByStyle();
}

function renderByVariant() {
  for (const plan of state.round.plans) {
    variantsEl.appendChild(buildVariantNode(plan));
  }
}

function planById(id) {
  return state.round.plans.find((p) => p.id === id);
}

function renderByPhrase() {
  // Group cells by base_text.
  const groups = new Map(); // baseText -> Array<{plan, sampleIndex, sample}>
  for (const plan of state.round.plans) {
    plan.samples.forEach((sample, s) => {
      const key = sample.base_text || sample.text;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ plan, sampleIndex: s, sample });
    });
  }
  for (const [phrase, cells] of groups) {
    variantsEl.appendChild(
      buildGroupNode({
        title: phrase,
        labelTag: "phrase",
        cells,
        cellShows: ["variant", "style"],
      })
    );
  }
}

function renderByStyle() {
  const groups = new Map(); // styleTag -> Array<{plan, sampleIndex, sample}>
  for (const plan of state.round.plans) {
    plan.samples.forEach((sample, s) => {
      const key = sample.style || "baseline";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ plan, sampleIndex: s, sample });
    });
  }
  for (const [style, cells] of groups) {
    variantsEl.appendChild(
      buildGroupNode({
        title: style,
        labelTag: "style",
        cells,
        cellShows: ["variant", "phrase"],
      })
    );
  }
}

function buildGroupNode({ title, labelTag, cells, cellShows }) {
  const node = variantTpl.content.firstElementChild.cloneNode(true);
  // Clear variant-specific stuff and re-purpose as a group card.
  node.classList.add("group");
  node.dataset.groupKey = labelTag + "::" + title;
  node.querySelector(".variant-num").textContent = "";
  node.querySelector(".variant-score-pill").remove();
  node.querySelector(".variant-actions").remove();

  const headLabel = document.createElement("span");
  headLabel.className = "group-label";
  headLabel.textContent = labelTag;
  const headTitle = document.createElement("span");
  headTitle.className = "group-title";
  headTitle.textContent = title;
  const refsEl = node.querySelector(".variant-refs");
  refsEl.parentElement.insertBefore(headLabel, refsEl);
  refsEl.parentElement.insertBefore(headTitle, refsEl);
  refsEl.remove();

  const cellsEl = node.querySelector(".variant-cells");
  for (const { plan, sampleIndex, sample } of cells) {
    cellsEl.appendChild(buildCellNode(plan, sampleIndex, sample, cellShows));
  }
  return node;
}

function buildVariantNode(plan) {
  const node = variantTpl.content.firstElementChild.cloneNode(true);
  node.dataset.planId = String(plan.id);
  node.querySelector(".variant-num").textContent = `#${plan.id}`;

  const refsEl = node.querySelector(".variant-refs");
  for (const name of plan.ref_names) {
    const pill = document.createElement("span");
    pill.className = "ref-pill";
    pill.textContent = name;
    pill.title = `Preview ${name}`;
    pill.addEventListener("click", () => previewRef(name));
    refsEl.appendChild(pill);
  }

  const cellsEl = node.querySelector(".variant-cells");
  plan.samples.forEach((sample, s) => {
    cellsEl.appendChild(buildCellNode(plan, s, sample, ["style", "phrase"]));
  });

  node.querySelector(".variant-copy").addEventListener("click", () => {
    copyRecipe({
      voice: state.round.voice,
      settings: state.round.settings,
      variant: {
        id: plan.id,
        refs: plan.ref_names,
        samples: plan.samples,
      },
    });
  });

  refreshVariantScore(plan);
  return node;
}

function buildCellNode(plan, sampleIndex, sample, cellShows = ["style", "phrase"]) {
  const node = cellTpl.content.firstElementChild.cloneNode(true);
  const key = cellKey(plan.id, sampleIndex);
  node.dataset.cellKey = key;

  const metaEl = node.querySelector(".cell-meta");
  const styleEl = node.querySelector(".cell-style");
  const textEl = node.querySelector(".cell-text");

  // Build the meta block in the order specified.
  // Always emit: top-line = first shown axis, second = second axis, etc.
  const tokens = [];
  for (const axis of cellShows) {
    if (axis === "variant") {
      tokens.push({ kind: "variant", value: `#${plan.id}`, refs: plan.ref_names });
    } else if (axis === "style") {
      tokens.push({
        kind: "style",
        value: sample.style || "baseline",
        baseline: !sample.style,
      });
    } else if (axis === "phrase") {
      tokens.push({ kind: "phrase", value: sample.base_text || sample.text });
    }
  }
  // Rewrite the .cell-style / .cell-text slots from tokens.
  if (tokens.length >= 1) {
    const t = tokens[0];
    if (t.kind === "style") {
      styleEl.textContent = t.value;
      if (t.baseline) styleEl.classList.add("baseline");
    } else if (t.kind === "variant") {
      styleEl.textContent = t.value;
      styleEl.classList.add("variant-tag");
      // Append ref pills
      const refsLine = document.createElement("span");
      refsLine.className = "cell-refs";
      for (const name of t.refs) {
        const pill = document.createElement("span");
        pill.className = "ref-pill ref-pill-mini";
        pill.textContent = name;
        pill.title = `Preview ${name}`;
        pill.addEventListener("click", (e) => {
          e.stopPropagation();
          previewRef(name);
        });
        refsLine.appendChild(pill);
      }
      metaEl.appendChild(refsLine);
    } else if (t.kind === "phrase") {
      styleEl.textContent = t.value;
      styleEl.classList.add("baseline");
    }
  }
  if (tokens.length >= 2) {
    const t = tokens[1];
    if (t.kind === "phrase") {
      textEl.textContent = t.value;
    } else if (t.kind === "style") {
      textEl.textContent = t.value;
    } else if (t.kind === "variant") {
      textEl.textContent = t.value;
    }
  } else {
    textEl.remove();
  }

  // Player play/pause button
  const playBtn = node.querySelector(".player-play");
  playBtn.addEventListener("click", () => togglePlay(key));

  const waveEl = node.querySelector(".player-waveform");
  waveEl.classList.add("empty", "queued");

  // Rating
  const rateBtns = node.querySelectorAll(".rate");
  rateBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const current = state.ratings.get(key) || 0;
      const v = Number(btn.dataset.rate);
      const next = current === v ? 0 : v;
      state.ratings.set(key, next);
      refreshCellRating(plan.id, sampleIndex);
      refreshVariantScore(plan);
      refreshRoundUI();
      renderRefPool();
      persistState();
    });
  });
  refreshCellRatingNode(node, key);
  return node;
}

function formatTime(sec) {
  if (!sec || !Number.isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function togglePlay(key) {
  const ws = state.players.get(key);
  if (!ws) return;
  // Pause every other instance so they don't overlap
  for (const [otherKey, other] of state.players) {
    if (otherKey !== key && other?.isPlaying?.()) other.pause();
  }
  if (ws.isPlaying()) ws.pause();
  else ws.play();
}

function attachPlayer(planId, sampleIndex) {
  const node = findCell(planId, sampleIndex);
  if (!node) return;
  const key = cellKey(planId, sampleIndex);
  const entry = state.audio.get(key);
  if (!entry?.blobUrl) return;
  if (state.players.has(key)) return;
  if (typeof WaveSurfer === "undefined") return;

  const waveEl = node.querySelector(".player-waveform");
  const playBtn = node.querySelector(".player-play");
  const timeEl = node.querySelector(".player-time");

  const ws = WaveSurfer.create({
    container: waveEl,
    waveColor: WAVE_COLOR,
    progressColor: PROGRESS_COLOR,
    cursorColor: "transparent",
    height: WAVE_HEIGHT,
    barWidth: 2,
    barGap: 1,
    barRadius: 2,
    normalize: true,
    interact: true,
    url: entry.blobUrl,
  });

  ws.on("ready", (duration) => {
    waveEl.classList.remove("empty", "queued", "errored", "stopped");
    playBtn.disabled = false;
    timeEl.textContent = formatTime(duration);
  });
  ws.on("play", () => playBtn.classList.add("playing"));
  ws.on("pause", () => playBtn.classList.remove("playing"));
  ws.on("finish", () => playBtn.classList.remove("playing"));
  ws.on("timeupdate", (t) => {
    timeEl.textContent = formatTime(t);
  });
  ws.on("error", (err) => {
    console.warn("wavesurfer", err);
    waveEl.classList.add("errored");
    playBtn.disabled = true;
  });

  state.players.set(key, ws);
}

function destroyPlayers() {
  for (const ws of state.players.values()) {
    try {
      ws.destroy();
    } catch (e) {
      /* ignore */
    }
  }
  state.players.clear();
}

function reattachAllPlayers() {
  if (!state.round) return;
  for (const plan of state.round.plans) {
    plan.samples.forEach((_, s) => {
      const key = cellKey(plan.id, s);
      const entry = state.audio.get(key);
      if (entry?.blobUrl) {
        attachPlayer(plan.id, s);
      }
      updateCellStatus(plan.id, s);
    });
    refreshVariantScore(plan);
  }
}

function findCell(planId, sampleIndex) {
  return variantsEl.querySelector(`.cell[data-cell-key="${planId}::${sampleIndex}"]`);
}

function updateCellStatus(planId, sampleIndex) {
  const node = findCell(planId, sampleIndex);
  if (!node) return;
  const key = cellKey(planId, sampleIndex);
  const entry = state.audio.get(key) || { status: "queued" };
  const statusEl = node.querySelector(".cell-status");
  const waveEl = node.querySelector(".player-waveform");
  const loadingText = entry.startedAt
    ? `loading ${formatDurationMs(performance.now() - entry.startedAt)}`
    : "loading…";
  statusEl.textContent =
    entry.status === "cached"
      ? "cached"
      : entry.status === "ready"
        ? "ready"
        : entry.status === "error"
          ? entry.error || "error"
          : entry.status === "loading"
            ? loadingText
            : entry.status === "stopped"
              ? "stopped"
              : "queued";
  statusEl.className = "cell-status " + entry.status;

  if (entry.status === "loading") {
    waveEl.classList.remove("queued", "errored", "stopped");
    waveEl.classList.add("empty");
  } else if (entry.status === "queued") {
    waveEl.classList.add("empty", "queued");
    waveEl.classList.remove("errored", "stopped");
  } else if (entry.status === "error") {
    waveEl.classList.add("empty", "errored");
    waveEl.classList.remove("queued", "stopped");
  } else if (entry.status === "stopped") {
    waveEl.classList.add("empty", "stopped");
    waveEl.classList.remove("queued", "errored");
  }
  refreshStopAllUI();
}

function updateCellAudio(planId, sampleIndex) {
  const node = findCell(planId, sampleIndex);
  if (!node) return;
  updateCellStatus(planId, sampleIndex);
  attachPlayer(planId, sampleIndex);
}

function refreshCellRating(planId, sampleIndex) {
  const node = findCell(planId, sampleIndex);
  if (!node) return;
  refreshCellRatingNode(node, cellKey(planId, sampleIndex));
}

function refreshCellRatingNode(node, key) {
  const current = state.ratings.get(key) || 0;
  node.querySelectorAll(".rate").forEach((btn) => {
    const v = Number(btn.dataset.rate);
    btn.classList.toggle("active", v === current);
  });
}

function refreshVariantScore(plan) {
  const node = variantsEl.querySelector(`.variant[data-plan-id="${plan.id}"]`);
  if (!node) return;
  const score = variantScore(plan);
  const pill = node.querySelector(".variant-score-pill");
  pill.textContent = score > 0 ? `+${score}` : String(score);
  node.classList.toggle("scored-good", score > 0);
  node.classList.toggle("scored-bad", score < 0);
}

// ─── Ref preview ──────────────────────────────────────────

let previewAudio = null;

function encodePathSegments(value) {
  return String(value).split("/").map(encodeURIComponent).join("/");
}

function previewRef(refName) {
  if (!state.voice) return;
  if (previewAudio) {
    previewAudio.pause();
    previewAudio = null;
  }
  const url = `/api/refs/${encodePathSegments(state.voice)}/${encodeURIComponent(refName)}`;
  previewAudio = new Audio(url);
  previewAudio.play().catch((err) => {
    console.warn("previewRef", err);
    setStatus(`Could not preview ${refName}`, "error");
  });
  setStatus(`Previewing source ref: ${refName}`);
}

// ─── Recipe export ────────────────────────────────────────

async function copyRecipe(recipe) {
  const text = JSON.stringify(recipe, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    setStatus("Recipe copied.", "success");
  } catch (err) {
    console.error(err);
    setStatus("Could not copy recipe.", "error");
  }
}

function saveWinner() {
  if (!state.round) return;
  const winners = state.round.plans
    .map((plan) => ({ plan, score: variantScore(plan) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);
  if (!winners.length) {
    setStatus("Rate at least one cell as great before saving.", "error");
    return;
  }
  copyRecipe({
    voice: state.round.voice,
    round: state.roundCounter,
    settings: state.round.settings,
    winners: winners.map(({ plan, score }) => ({
      id: plan.id,
      score,
      refs: plan.ref_names,
    })),
  });
}

// ─── History strip ────────────────────────────────────────

function renderHistoryStrip() {
  const stripEl = $("history-strip");
  if (!stripEl) return;
  if (!state.history.length) {
    stripEl.hidden = true;
    stripEl.innerHTML = "";
    return;
  }
  stripEl.hidden = false;
  stripEl.innerHTML = "";

  const header = document.createElement("div");
  header.className = "history-header";
  header.innerHTML = `<h3>Previous rounds</h3><span class="rail-meta">${state.history.length} kept &middot; audio not stored</span>`;
  stripEl.appendChild(header);

  const list = document.createElement("div");
  list.className = "history-rounds";
  for (const entry of state.history) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "history-pill";
    const good = entry.summary?.positives || 0;
    const bad = entry.summary?.negatives || 0;
    const elapsed = friendlyAgo(entry.ts);
    pill.innerHTML = `
      <span>Round ${escapeHTML(entry.id)}</span>
      ${good ? `<span class="pill-score-good">+${good}</span>` : ""}
      ${bad ? `<span class="pill-score-bad">-${bad}</span>` : ""}
      <span class="pill-time">${escapeHTML(elapsed)}</span>
    `;
    pill.title = `Restore round ${entry.id} (re-renders ${entry.plans.length * (entry.plans[0]?.samples?.length || 0)} cells)`;
    pill.addEventListener("click", () => restoreRound(entry));
    list.appendChild(pill);
  }
  stripEl.appendChild(list);
}

function friendlyAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function restoreRound(entry) {
  const cells = entry.plans.length * (entry.plans[0]?.samples?.length || 0);
  if (
    !confirm(
      `Restore round ${entry.id}? Audio isn't stored, so this will re-render ${cells} cells.`
    )
  ) {
    return;
  }
  // Save current round to history if it exists.
  if (state.round) {
    const ratingsSnap = Object.fromEntries(state.ratings);
    const positives = Object.values(ratingsSnap).filter((v) => v > 0).length;
    const negatives = Object.values(ratingsSnap).filter((v) => v < 0).length;
    state.history.unshift({
      id: state.round.id,
      voice: state.round.voice,
      plans: state.round.plans,
      settings: state.round.settings,
      ratings: ratingsSnap,
      ts: Date.now(),
      summary: { positives, negatives, variants: state.round.plans.length },
    });
  }
  // Pop the chosen entry from history.
  state.history = state.history.filter((h) => h !== entry).slice(0, HISTORY_LIMIT);

  // Restore the round.
  state.round = {
    id: entry.id,
    voice: entry.voice,
    plans: entry.plans,
    settings: entry.settings,
  };
  state.ratings = new Map(
    Object.entries(entry.ratings || {}).map(([k, v]) => [k, Number(v)])
  );
  abortAudioFetches();
  destroyPlayers();
  for (const [, audioEntry] of state.audio) {
    if (audioEntry?.blobUrl) URL.revokeObjectURL(audioEntry.blobUrl);
  }
  state.audio = new Map();

  renderVariants();
  refreshRoundUI();
  renderRefPool();
  renderHistoryStrip();

  // Re-fetch audio.
  startAudioProgress(state.round.id, totalAudioCells(entry.plans), "Re-rendering");
  for (const plan of entry.plans) {
    plan.samples.forEach((sample, s) => {
      const key = cellKey(plan.id, s);
      state.audio.set(key, { status: "queued" });
      updateCellStatus(plan.id, s);
      const ctx = {
        roundId: state.round.id,
        runId: state.ui.audioRunId,
        voice: state.round.voice,
        settings: state.round.settings,
      };
      queueAudioFetch(() => fetchAudio(plan, s, sample, ctx));
    });
  }
  updateAudioProgressStatus();
  persistState();
}

// ─── Fish health ──────────────────────────────────────────

let healthPollTimer = null;
const HEALTH_POLL_MS = 15_000;

async function checkFishHealth({ silent = false } = {}) {
  try {
    const resp = await fetch("/api/health", { cache: "no-store" });
    if (!resp.ok) throw new Error(`health ${resp.status}`);
    const data = await resp.json();
    state.fish = data;
  } catch (err) {
    state.fish = { fish: "offline", url: state.fish.url || "" };
  }
  renderFishStatus();
  // Poll while not ok; stop polling when healthy.
  if (state.fish.fish === "ok") {
    if (healthPollTimer) {
      clearInterval(healthPollTimer);
      healthPollTimer = null;
    }
  } else if (!healthPollTimer && !silent) {
    healthPollTimer = setInterval(
      () => checkFishHealth({ silent: true }),
      HEALTH_POLL_MS
    );
  }
}

function fishOk() {
  return state.fish.fish === "ok";
}

function usesHostedFishAudio() {
  return state.fish.kind === "hosted";
}

function renderFishStatus() {
  const dot = $("fish-dot");
  if (dot) {
    dot.dataset.state = state.fish.fish || "checking";
    dot.title = fishStatusTitle();
  }
  // Re-derive button disabled state.
  refreshRoundUI();
  renderSetupCard();
}

function fishStatusTitle() {
  switch (state.fish.fish) {
    case "ok":
      return `Fish-Speech reachable at ${state.fish.url}`;
    case "offline":
      return `Fish-Speech offline — ${state.fish.url}`;
    case "unauthorized":
      return `Fish-Speech reachable but rejected the request (check API key)`;
    case "checking":
    default:
      return "Checking Fish-Speech…";
  }
}

function renderSetupCard() {
  const card = $("fish-setup");
  if (!card) return;
  const f = state.fish || {};
  if (f.fish === "ok" || f.fish === "checking") {
    card.hidden = true;
    card.innerHTML = "";
    card.className = "setup-card";
    return;
  }
  card.hidden = false;
  card.className =
    "setup-card kind-" + (f.fish === "unauthorized" ? "unauthorized" : "offline");

  const url = f.url || "the configured endpoint";
  const isLocal = f.kind === "local";
  const isHosted = f.kind === "hosted";
  const hasKey = !!f.has_key;
  const codeBlock = (value) =>
    `<code class="setup-code-block">${escapeHTML(value)}</code>`;

  const title =
    f.fish === "unauthorized"
      ? "Fish endpoint rejected the request"
      : "Fish-Speech isn't reachable";

  const tagText = f.fish === "unauthorized" ? "401 / 403" : "offline";

  const steps = [];
  if (f.fish === "unauthorized") {
    steps.push(
      `Confirm <code>FISH_API_KEY</code> in <code>.env</code> matches your account.`
    );
    if (isHosted) {
      steps.push(
        `Verify the key has access to model <code>${escapeHTML(f.model || "s2-pro")}</code>.`
      );
    }
    steps.push(`Restart Refinery so the new key is picked up.`);
  } else if (isLocal) {
    steps.push(
      `Start the Fish-Speech API server. On macOS:${codeBlock("scripts/start-fish-macos.sh")}`
    );
    steps.push(
      `On Linux + CUDA:${codeBlock("docker compose --profile fish up")}See README for details.`
    );
    steps.push(
      `Or point Refinery at the hosted API by setting <code>FISH_TTS_URL</code> and <code>FISH_API_KEY</code> in <code>.env</code>, then restart.`
    );
  } else if (isHosted) {
    steps.push(`Check your network. Refinery couldn't reach:${codeBlock(url)}`);
    if (!hasKey)
      steps.push(
        `Set <code>FISH_API_KEY</code> in <code>.env</code> and restart Refinery.`
      );
    steps.push(
      `If the hosted API is degraded, fall back to a local Fish-Speech and update <code>FISH_TTS_URL</code>.`
    );
  } else {
    steps.push(`Refinery couldn't reach:${codeBlock(url)}`);
    steps.push(
      "Confirm the configured endpoint, start the server, and check local network or firewall rules."
    );
  }

  card.innerHTML = `
    <div class="setup-head">
      <h2>${title}</h2>
      <span class="setup-tag">${tagText}</span>
    </div>
    <div class="setup-body">
      <p>Generation is paused until the endpoint comes back. You can still browse the reference pool, preview source clips, and tweak phrases/styles.</p>
      <div class="setup-meta">
        <span><span class="meta-label">Endpoint</span><code>${escapeHTML(url)}</code></span>
        <span><span class="meta-label">Model</span><code>${escapeHTML(f.model || "s2-pro")}</code></span>
        <span><span class="meta-label">API key</span><span>${hasKey ? "set" : "unset"}</span></span>
      </div>
      <ol class="setup-steps">
        ${steps.map((s) => `<li><span class="setup-step-copy">${s}</span></li>`).join("")}
      </ol>
      <div class="setup-actions">
        <button class="btn btn-outline" id="recheck-fish">Re-check</button>
        <a class="btn btn-ghost" href="https://github.com/mikeharty/refinery#readme" target="_blank" rel="noopener">Open docs</a>
        <span class="setup-hint">Checking every 15s</span>
      </div>
    </div>
  `;
  card.querySelector("#recheck-fish")?.addEventListener("click", () => {
    const dot = $("fish-dot");
    if (dot) dot.dataset.state = "checking";
    fetch("/api/health?refresh=1", { cache: "no-store" }).finally(() =>
      checkFishHealth({ silent: true })
    );
  });
}

function escapeHTML(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

// ─── Keyboard ─────────────────────────────────────────────

function focusedCellKey() {
  const active = document.activeElement;
  if (active && active.classList.contains("cell") && active.dataset.cellKey) {
    return active.dataset.cellKey;
  }
  // If nothing focused, fall back to first visible cell.
  const first = variantsEl.querySelector(".cell[data-cell-key]");
  return first?.dataset.cellKey || null;
}

function moveCellFocus(delta) {
  const cells = [...variantsEl.querySelectorAll(".cell[data-cell-key]")];
  if (!cells.length) return;
  const current = document.activeElement?.classList?.contains("cell")
    ? cells.indexOf(document.activeElement)
    : -1;
  const next = current < 0 ? 0 : (current + delta + cells.length) % cells.length;
  cells[next].focus();
  cells[next].scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function rateFocused(value) {
  const key = focusedCellKey();
  if (!key) return;
  const [planIdStr, idxStr] = key.split("::");
  const planId = Number(planIdStr);
  const sampleIndex = Number(idxStr);
  const current = state.ratings.get(key) || 0;
  const next = current === value ? 0 : value;
  state.ratings.set(key, next);
  refreshCellRating(planId, sampleIndex);
  const plan = state.round?.plans.find((p) => p.id === planId);
  if (plan) refreshVariantScore(plan);
  refreshRoundUI();
  renderRefPool();
  persistState();
}

function togglePlayFocused() {
  const key = focusedCellKey();
  if (!key) return;
  togglePlay(key);
}

function handleKeydown(e) {
  if (e.target.matches("input, textarea, select")) return;
  if (e.metaKey || e.ctrlKey) return;
  const k = e.key;
  const kl = k.toLowerCase();
  if (kl === "g" && !e.altKey) {
    e.preventDefault();
    if (!generateBtn.disabled) generateBtn.click();
  } else if (kl === "r" && !e.altKey) {
    e.preventDefault();
    if (!refineBtn.disabled) refineBtn.click();
  } else if (kl === "s" && !e.altKey) {
    e.preventDefault();
    if (!saveWinnerBtn.disabled) saveWinnerBtn.click();
  } else if (k === " " || k === "Spacebar") {
    e.preventDefault();
    togglePlayFocused();
  } else if (k === "1") {
    e.preventDefault();
    rateFocused(1);
  } else if (k === "2") {
    e.preventDefault();
    rateFocused(0);
  } else if (k === "3") {
    e.preventDefault();
    rateFocused(-1);
  } else if (k === "ArrowDown" || k === "ArrowRight") {
    e.preventDefault();
    moveCellFocus(1);
  } else if (k === "ArrowUp" || k === "ArrowLeft") {
    e.preventDefault();
    moveCellFocus(-1);
  }
}

// ─── Boot ─────────────────────────────────────────────────

function restorePersisted() {
  const data = loadPersisted();
  if (!data) return;
  if (data.voice && BOOT.voices.includes(data.voice)) {
    state.voice = data.voice;
    voiceEl.value = data.voice;
  }
  if (data.config) state.config = { ...state.config, ...data.config };
  if (Array.isArray(data.texts) && data.texts.length)
    state.texts = normalizeTextEntries(data.texts);
  if (Array.isArray(data.styles) && data.styles.length) state.styles = data.styles;
  if (data.settings)
    state.settings = mergeSettings(DEFAULT_TTS_SETTINGS, data.settings);
  if (typeof data.modelPreset === "string") state.ui.modelPreset = data.modelPreset;
  if (data.viewBy) {
    const migratedDefault = localStorage.getItem(VIEW_DEFAULT_MIGRATION_KEY) === "1";
    state.ui.viewBy =
      !migratedDefault && data.viewBy === "phrase" ? DEFAULT_VIEW_BY : data.viewBy;
    localStorage.setItem(VIEW_DEFAULT_MIGRATION_KEY, "1");
  }
  if (Number.isFinite(data.roundCounter)) state.roundCounter = data.roundCounter;
  if (Array.isArray(data.history)) state.history = data.history.slice(0, HISTORY_LIMIT);
  if (Array.isArray(data.pinned)) state.pinned = new Set(data.pinned);
  if (Array.isArray(data.excluded)) state.excluded = new Set(data.excluded);

  // If a current round was persisted, move it into history (audio blobs are gone).
  if (data.currentRound) {
    const cr = data.currentRound;
    const ratingsSnap = cr.ratings || {};
    const positives = Object.values(ratingsSnap).filter((v) => Number(v) > 0).length;
    const negatives = Object.values(ratingsSnap).filter((v) => Number(v) < 0).length;
    state.history.unshift({
      id: cr.id,
      voice: cr.voice,
      plans: cr.plans,
      settings: cr.settings,
      ratings: ratingsSnap,
      ts: Date.now() - 1,
      summary: { positives, negatives, variants: cr.plans?.length || 0 },
    });
    state.history = state.history.slice(0, HISTORY_LIMIT);
  }

  // Sliders need their DOM value set before applyDefaultSettings/binding update
  if (nRefsEl) nRefsEl.value = String(state.config.nRefs);
  if (limitEl) limitEl.value = String(state.config.limit);
}

function applyViewByUI() {
  document.querySelectorAll(".view-opt").forEach((b) => {
    const active = b.dataset.view === state.ui.viewBy;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", String(active));
  });
}

function init() {
  if (!BOOT.voices?.length) return;

  restorePersisted();

  // bind topbar voice + sliders
  voiceEl.addEventListener("change", () => {
    state.voice = voiceEl.value;
    state.pinned = new Set();
    state.excluded = new Set();
    state.ui.refQuery = "";
    state.ui.refPoolExpanded = false;
    if (refFilterEl) refFilterEl.value = "";
    updatePoolInfo();
    state.texts = defaultTextEntries(state.voice);
    renderTexts();
    renderRefPool();
    updateCostUI();
  });

  refFilterEl?.addEventListener("input", () => {
    state.ui.refQuery = refFilterEl.value;
    renderRefPool();
  });

  refPoolToggleEl?.addEventListener("click", () => {
    state.ui.refPoolExpanded = !state.ui.refPoolExpanded;
    renderRefPool();
  });

  bindRange(
    "n_refs",
    (v) => String(v),
    (v) => {
      state.config.nRefs = Number(v);
      updateCostUI();
    }
  );
  bindRange(
    "limit",
    (v) => String(v),
    (v) => {
      state.config.limit = Number(v);
      updateCostUI();
    }
  );

  // generation settings
  const fmt2 = (v) => Number(v).toFixed(2);
  const fmtInt = (v) => String(Number(v));
  bindRange("temperature", fmt2);
  bindRange("top_p", fmt2);
  bindRange("repetition_penalty", fmt2);
  bindRange("speed", fmt2);
  bindRange("volume", fmtInt);
  bindRange("chunk_length", fmtInt);
  bindRange("max_new_tokens", fmtInt);

  applySettingsToControls(state.settings, { presetKey: state.ui.modelPreset });
  bindSettingsControls();
  state.voice = voiceEl.value;
  updatePoolInfo();
  if (!state.texts.length) state.texts = defaultTextEntries(state.voice);
  if (!state.styles.length) state.styles = [""];
  renderTexts();
  renderStyles();
  renderRefPool();
  applyViewByUI();
  renderHistoryStrip();
  updateCostUI();

  // Text/style add buttons
  modelPresetEl?.addEventListener("change", () => {
    const key = modelPresetEl.value;
    if (key === "custom") return;
    applySettingsToControls(settingsForPreset(key), { presetKey: key, persist: true });
  });
  resetSettingsBtn?.addEventListener("click", () => {
    applySettingsToControls(settingsForPreset("default"), {
      presetKey: "default",
      persist: true,
    });
  });
  resetTextsBtn?.addEventListener("click", () => {
    state.texts = defaultTextEntries(state.voice);
    renderTexts();
    updateCostUI();
    textsContainer.querySelector("textarea")?.focus();
  });
  selectAllTextsBtn?.addEventListener("click", selectAllTexts);
  selectNoneTextsBtn?.addEventListener("click", deselectAllTexts);
  $("add-text").addEventListener("click", () => {
    state.texts.push({
      value: "",
      selected: selectedTextCount() < MAX_TEXTS_PER_VARIANT,
    });
    renderTexts();
    updateCostUI();
    textsContainer.lastElementChild?.querySelector("textarea")?.focus();
  });
  $("add-style").addEventListener("click", () => {
    state.styles.push("");
    renderStyles();
    updateCostUI();
    stylesContainer.lastElementChild?.querySelector("textarea")?.focus();
  });
  $("style-preset").addEventListener("click", () => {
    state.styles = [
      "",
      "[professional broadcast tone]",
      "[curious and precise]",
      "[soft tone, slightly slower]",
    ];
    renderStyles();
    updateCostUI();
  });

  // Action buttons
  generateBtn.addEventListener("click", () => generate({ refining: false }));
  refineBtn.addEventListener("click", () => generate({ refining: true }));
  saveWinnerBtn.addEventListener("click", saveWinner);
  stopAllBtn?.addEventListener("click", () => stopAllGeneration());

  // View toggle
  document.querySelectorAll(".view-opt").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.dataset.view;
      if (state.ui.viewBy === v) return;
      state.ui.viewBy = v;
      document.querySelectorAll(".view-opt").forEach((b) => {
        const active = b.dataset.view === v;
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", String(active));
      });
      renderVariants();
      reattachAllPlayers();
    });
  });

  document.addEventListener("keydown", handleKeydown);

  renderVariants();
  refreshRoundUI();
  checkFishHealth();
}

document.addEventListener("DOMContentLoaded", init);
