// app.js – clean v1 wired to Flask backend

const ELECTRICITY_PRICE_TL_PER_KWH = 3.1;
const PRICE_GROWTH_RATE = 0.25; // 25%/year
const CO2_KG_PER_KWH = 0.45;
const SAVINGS_HORIZON_YEARS = 5;

// ---------- Helpers ----------

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} for ${url}: ${text}`);
  }
  return res.json();
}

function niceKeyName(key) {
  if (!key) return "";
  return key
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatKwh(v) {
  return `${v.toFixed(2)} kWh`;
}

function formatMoneyTL(v) {
  return `${v.toLocaleString("tr-TR", {
    maximumFractionDigits: 0,
  })} TL`;
}

function formatCo2Kg(v) {
  return `${v.toLocaleString("tr-TR", {
    maximumFractionDigits: 0,
  })} kg CO₂`;
}

// ---------- Global state ----------

const state = {
  mode: "premade", // or "custom"
  data: {
    archetypes: {},
    packs: {
      ac1p: {},
      ac3p: {},
      dc12: {},
      dc24: {},
      dc48: {},
    },
    tiers: {},
    solar: {},
  },
  archetypeKey: null,
  expertMode: false,
  selectedPacks: [], // { id, group, key, usageIndex }
  selectedCity: null,
  solarWp: 0,
  nextPackId: 1,
};

// ---------- Data loading ----------

async function loadData() {
  try {
    const initData = await fetchJson("/api/init");

    state.data.archetypes = initData.archetypes || {};
    state.data.packs.ac1p = initData.packs?.ac1p || {};
    state.data.packs.ac3p = initData.packs?.ac3p || {};
    state.data.packs.dc12 = initData.packs?.dc12 || {};
    state.data.packs.dc24 = initData.packs?.dc24 || {};
    state.data.packs.dc48 = initData.packs?.dc48 || {};
    state.data.tiers = initData.tiers || {};
    state.data.solar = initData.solar || {};

    console.log("Init data loaded:", initData);

    initArchetypes();
    initCitySelect();
    renderPackList("ac1p");
    renderPremadePacks();
  } catch (err) {
    console.error("Failed to load init data:", err);
  }
}

// ---------- UI init ----------

function initArchetypes() {
  const select = document.getElementById("archetypeSelect");
  select.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select home archetype…";
  placeholder.disabled = true;
  placeholder.selected = true;
  select.appendChild(placeholder);

  Object.keys(state.data.archetypes).forEach((key) => {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = niceKeyName(key);
    select.appendChild(option);
  });

  // Optional default
  if (state.data.archetypes["two_plus_one_family"]) {
    select.value = "two_plus_one_family";
    state.archetypeKey = "two_plus_one_family";
  }

  select.addEventListener("change", (e) => {
    state.archetypeKey = e.target.value || null;
  });
}

function initCitySelect() {
  const select = document.getElementById("citySelect");
  select.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select city…";
  placeholder.disabled = true;
  placeholder.selected = true;
  select.appendChild(placeholder);

  const cities = Object.keys(state.data.solar || {}).sort();
  cities.forEach((city) => {
    const opt = document.createElement("option");
    opt.value = city;
    opt.textContent = city;
    select.appendChild(opt);
  });

  if (cities.length > 0) {
    select.value = cities[0];
    state.selectedCity = cities[0];
  }

  select.addEventListener("change", (e) => {
    state.selectedCity = e.target.value || null;
  });
}

// ---------- Packs UI ----------

function renderPackList(group) {
  const container = document.getElementById("packList");
  container.innerHTML = "";

  const db = state.data.packs[group] || {};
  const entries = Object.entries(db);

  if (entries.length === 0) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "No packs defined for this group in dataset.";
    container.appendChild(p);
    return;
  }

  entries.forEach(([key, pack]) => {
    const div = document.createElement("div");
    div.className = "pack-item";

    const title = document.createElement("h4");
    title.textContent = niceKeyName(key);
    div.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "pack-meta";
    const [kMin, kAvg, kMax] = pack.kwh_day || [0, 0, 0];
    const [pMin, pAvg, pMax] = pack.peak_w || [0, 0, 0];
    meta.textContent = `Energy: ${kMin}-${kAvg}-${kMax} kWh/day · Peak: ${pMin}-${pAvg}-${pMax} W`;
    div.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "pack-actions";

    const usageHint = document.createElement("span");
    usageHint.className = "usage-label";
    usageHint.textContent = "Add to selection";
    actions.appendChild(usageHint);

    const btn = document.createElement("button");
    btn.className = "btn btn-secondary";
    btn.textContent = "+ Add";
    btn.addEventListener("click", () => {
      addPack(group, key);
    });
    actions.appendChild(btn);

    div.appendChild(actions);
    container.appendChild(div);
  });
}

function addPack(group, key) {
  const id = state.nextPackId++;
  state.selectedPacks.push({
    id,
    group,
    key,
    usageIndex: 1, // typical
  });
  renderSelectedPacks();
}

function removePack(id) {
  state.selectedPacks = state.selectedPacks.filter((p) => p.id !== id);
  renderSelectedPacks();
}

function updatePackUsage(id, usageIndex) {
  const p = state.selectedPacks.find((x) => x.id === id);
  if (p) {
    p.usageIndex = usageIndex;
  }
}

function renderSelectedPacks() {
  const empty = document.getElementById("selectedPacksEmpty");
  const table = document.getElementById("selectedPacksTable");
  const tbody = document.getElementById("selectedPacksBody");

  if (state.selectedPacks.length === 0) {
    empty.classList.remove("hidden");
    table.classList.add("hidden");
    tbody.innerHTML = "";
    return;
  }

  empty.classList.add("hidden");
  table.classList.remove("hidden");
  tbody.innerHTML = "";

  state.selectedPacks.forEach((pack) => {
    const tr = document.createElement("tr");

    const tdName = document.createElement("td");
    tdName.textContent = niceKeyName(pack.key);
    tr.appendChild(tdName);

    const tdGroup = document.createElement("td");
    tdGroup.textContent = pack.group.toUpperCase();
    tr.appendChild(tdGroup);

    const tdUsage = document.createElement("td");
    const sliderWrap = document.createElement("div");
    sliderWrap.className = "usage-slider";

    const input = document.createElement("input");
    input.type = "range";
    input.min = "0";
    input.max = "2";
    input.step = "1";
    input.value = String(pack.usageIndex);
    input.addEventListener("input", (e) => {
      updatePackUsage(pack.id, Number(e.target.value));
    });

    const label = document.createElement("span");
    label.className = "usage-label";
    label.textContent = ["Low", "Typical", "High"][pack.usageIndex] || "Typical";

    input.addEventListener("change", () => {
      label.textContent = ["Low", "Typical", "High"][Number(input.value)] || "Typical";
    });

    sliderWrap.appendChild(input);
    sliderWrap.appendChild(label);
    tdUsage.appendChild(sliderWrap);
    tr.appendChild(tdUsage);

    const tdRemove = document.createElement("td");
    const btnRem = document.createElement("button");
    btnRem.className = "remove-btn";
    btnRem.textContent = "Remove";
    btnRem.addEventListener("click", () => removePack(pack.id));
    tdRemove.appendChild(btnRem);
    tr.appendChild(tdRemove);

    tbody.appendChild(tr);
  });
}

// ---------- Premade packs (simple placeholder for now) ----------

function renderPremadePacks() {
  const container = document.getElementById("premadeGrid");
  if (!container) return;
  container.innerHTML = "";

  // For v1, we can just map some archetypes + tiers as "scenarios"
  const archetypeKeys = Object.keys(state.data.archetypes);
  if (archetypeKeys.length === 0) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent =
      "Pre-made scenarios will appear here once archetypes are loaded.";
    container.appendChild(p);
    return;
  }

  archetypeKeys.slice(0, 4).forEach((key) => {
    const card = document.createElement("div");
    card.className = "premade-card";

    const h3 = document.createElement("h3");
    h3.textContent = niceKeyName(key);
    card.appendChild(h3);

    const small = document.createElement("small");
    small.textContent = "Example lifestyle based on this archetype.";
    card.appendChild(small);

    const tags = document.createElement("div");
    tags.className = "premade-tags";
    ["Archetype", "Showcase only"].forEach((t) => {
      const span = document.createElement("span");
      span.className = "tag";
      span.textContent = t;
      tags.appendChild(span);
    });
    card.appendChild(tags);

    const footer = document.createElement("div");
    footer.className = "premade-footer";
    footer.innerHTML =
      '<span>See suggested EcoFlow tier</span><span style="font-size:0.8rem;opacity:0.8;">(static demo)</span>';
    card.appendChild(footer);

    container.appendChild(card);
  });
}

// ---------- Simulation: call backend ----------

async function simulate() {
  if (!state.expertMode && !state.archetypeKey) {
    alert("Please select a home archetype or enable Expert mode.");
    return null;
  }

  if (!state.selectedCity) {
    alert("Please select a city for solar yield.");
    return null;
  }

  if (!state.solarWp || state.solarWp <= 0) {
    alert("Please configure solar (choose a preset or enter PV size).");
    return null;
  }

  const payload = {
    archetype_id: state.archetypeKey,
    expert_mode: state.expertMode,
    city: state.selectedCity,
    solar_wp: state.solarWp,
    packs: state.selectedPacks.map((p) => ({
      group: p.group,
      key: p.key,
      usage_index: p.usageIndex,
    })),
  };

  console.log("Simulate payload:", payload);

  const data = await fetchJson("/api/calculate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  console.log("Simulate result:", data);
  return data;
}

function renderResults(data) {
  const resultsSection = document.getElementById("resultsSection");
  const profile = data.profile || {};
  const rec = (data.recommendations && data.recommendations[0]) || null;

  const [kMin, kAvg, kMax] = profile.daily_kwh_band || [0, 0, 0];
  const [pMin, pAvg, pMax] = profile.peak_power_band_w || [0, 0, 0];

  // Consumption
  document.getElementById(
    "consumptionSummary"
  ).textContent = `Typical daily consumption: ${formatKwh(kAvg || 0)}`;
  document.getElementById(
    "consumptionMin"
  ).textContent = `Min: ${formatKwh(kMin || 0)}`;
  document.getElementById(
    "consumptionAvg"
  ).textContent = `Typical: ${formatKwh(kAvg || 0)}`;
  document.getElementById(
    "consumptionMax"
  ).textContent = `Max: ${formatKwh(kMax || 0)}`;
  document.getElementById(
    "peakSummary"
  ).textContent = `Estimated peak power band: ${pMin}-${pAvg}-${pMax} W (min/typical/max).`;

  // Solar
  const solar = profile.solar || {};
  if (solar.avg_daily_kwh) {
    document.getElementById(
      "solarSummary"
    ).textContent = `Solar produces ~${formatKwh(
      solar.avg_daily_kwh
    )} on an average day in ${solar.city}.`;
    document.getElementById(
      "solarSummer"
    ).textContent = `Summer average: ${formatKwh(
      solar.summer_daily_kwh || 0
    )}`;
    document.getElementById(
      "solarWinter"
    ).textContent = `Winter average: ${formatKwh(
      solar.winter_daily_kwh || 0
    )}`;
  } else {
    document.getElementById("solarSummary").textContent =
      "No solar configured.";
    document.getElementById("solarSummer").textContent = "";
    document.getElementById("solarWinter").textContent = "";
  }

  // Savings
  const savings = profile.savings || {};
  if (savings.year1_savings_tl) {
    document.getElementById(
      "savingsSummary"
    ).textContent = `You offset ~${formatKwh(
      savings.daily_offset_kwh || 0
    )} grid energy per day.`;
    document.getElementById(
      "savingsYear1"
    ).textContent = `Year 1 bill saving: ${formatMoneyTL(
      savings.year1_savings_tl || 0
    )}`;
    document.getElementById(
      "savingsYear5"
    ).textContent = `${SAVINGS_HORIZON_YEARS}-year projected saving (25%/year price rise): ${formatMoneyTL(
      savings.multi_year_savings_tl || 0
    )}`;
    document.getElementById(
      "co2Summary"
    ).textContent = `Annual CO₂ reduction: ${formatCo2Kg(
      savings.yearly_co2_kg || 0
    )}`;
  } else {
    document.getElementById("savingsSummary").textContent =
      "Add solar to see bill & CO₂ savings.";
    document.getElementById("savingsYear1").textContent = "";
    document.getElementById("savingsYear5").textContent = "";
    document.getElementById("co2Summary").textContent = "";
  }

  // EcoFlow tier
  const tierTitle = document.getElementById("tierTitle");
  const tierUsage = document.getElementById("tierUsage");
  const tierDetails = document.getElementById("tierDetails");
  tierDetails.innerHTML = "";

  if (!rec) {
    tierTitle.textContent = "No tier selected.";
    tierUsage.textContent = "Adjust your inputs and try again.";
  } else {
    tierTitle.textContent = `${rec.tier_id || "EcoFlow tier"} – ${rec.name || "Unnamed bundle"}`;
    tierUsage.textContent =
      "Sized to cover your typical daily load and peak power with a margin.";

    const liCap = document.createElement("li");
    liCap.textContent = `Usable battery capacity: ${
      rec.capacity_wh_total
    } Wh`;
    tierDetails.appendChild(liCap);

    const liInv = document.createElement("li");
    liInv.textContent = `Inverter continuous power: ${
      rec.inverter_w_continuous
    } W`;
    tierDetails.appendChild(liInv);

    if (rec.pv_input_w_max) {
      const liPv = document.createElement("li");
      liPv.textContent = `PV input max: ${rec.pv_input_w_max} W`;
      tierDetails.appendChild(liPv);
    }

    if (Array.isArray(rec.products)) {
      const liProd = document.createElement("li");
      liProd.textContent = `Bundle includes: ${rec.products.join(", ")}`;
      tierDetails.appendChild(liProd);
    }
  }

  resultsSection.classList.remove("hidden");
}

// ---------- Wiring ----------

function wireUI() {
  const btnModePremade = document.getElementById("btnModePremade");
  const btnModeCustom = document.getElementById("btnModeCustom");
  const premadeSection = document.getElementById("premadeSection");
  const customSection = document.getElementById("customSection");
  const resultsSection = document.getElementById("resultsSection");

  btnModePremade.addEventListener("click", () => {
    state.mode = "premade";
    btnModePremade.classList.add("btn-primary");
    btnModePremade.classList.remove("btn-secondary");
    btnModeCustom.classList.add("btn-secondary");
    btnModeCustom.classList.remove("btn-primary");
    premadeSection.classList.remove("hidden");
    customSection.classList.add("hidden");
    resultsSection.classList.add("hidden");
  });

  btnModeCustom.addEventListener("click", () => {
    state.mode = "custom";
    btnModeCustom.classList.add("btn-primary");
    btnModeCustom.classList.remove("btn-secondary");
    btnModePremade.classList.add("btn-secondary");
    btnModePremade.classList.remove("btn-primary");
    premadeSection.classList.add("hidden");
    customSection.classList.remove("hidden");
  });

  // Tabs
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const group = tab.dataset.packGroup;
      renderPackList(group);
    });
  });

  // Expert mode checkbox
  document.getElementById("expertMode").addEventListener("change", (e) => {
    state.expertMode = e.target.checked;
  });

  // Solar presets
  const solarButtons = document.querySelectorAll("[data-solar-preset]");
  const solarInput = document.getElementById("solarWpInput");

  solarButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const wp = Number(btn.dataset.solarPreset);
      state.solarWp = wp;
      solarInput.value = wp || "";

      solarButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });

  // Custom solar input
  solarInput.addEventListener("input", (e) => {
    const val = Number(e.target.value) || 0;
    state.solarWp = val;
    solarButtons.forEach((b) => b.classList.remove("active"));
  });

  // City select change handled in initCitySelect, but we also ensure the value is tracked if user edits after load
  document.getElementById("citySelect").addEventListener("change", (e) => {
    state.selectedCity = e.target.value || null;
  });

  // Simulate button
  document.getElementById("btnSimulate").addEventListener("click", async () => {
    try {
      const data = await simulate();
      if (data) {
        renderResults(data);
      }
    } catch (err) {
      console.error("Simulation failed:", err);
      alert("Simulation failed, check console for details.");
    }
  });
}

// ---------- Boot ----------

document.addEventListener("DOMContentLoaded", () => {
  wireUI();
  loadData();
});
