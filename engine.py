import json
import os
from typing import Any, Dict, List, Optional, Tuple

# ---------- Paths & loaders ----------

DATA_DIR = os.path.join(os.path.dirname(__file__), "datasets")


def load_db(filename: str) -> Dict[str, Any]:
    path = os.path.join(DATA_DIR, filename)
    if not os.path.exists(path):
        raise FileNotFoundError(f"Dataset file not found: {path}")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# ---------- Databases ----------

archetypes_db: Dict[str, Any] = load_db("archetypes.json")
ecoflow_tiers_db: Dict[str, Any] = load_db("ecoflow_tiers.json")
packs_ac1p_db: Dict[str, Any] = load_db("packs-AC1P.json")
packs_ac3p_db: Dict[str, Any] = load_db("packs-AC3P.json")
packs_dc12v_db: Dict[str, Any] = load_db("packs-DC12V.json")
packs_dc24v_db: Dict[str, Any] = load_db("packs-DC24V.json")
packs_dc48v_db: Dict[str, Any] = load_db("packs-DC48V.json")
solar_generation_db: Dict[str, Any] = load_db("solar_generation.json")


# ---------- Helpers ----------

def _get_pack_db(group: str) -> Dict[str, Any]:
    group = (group or "").lower()
    if group in {"ac1p", "ac", "ac_1p"}:
        return packs_ac1p_db
    if group in {"ac3p", "ac_3p"}:
        return packs_ac3p_db
    if group in {"dc12", "dc12v"}:
        return packs_dc12v_db
    if group in {"dc24", "dc24v"}:
        return packs_dc24v_db
    if group in {"dc48", "dc48v"}:
        return packs_dc48v_db
    raise KeyError(f"Unknown pack group: {group}")


def _safe_band(value: Any) -> Tuple[float, float, float]:
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        return (0.0, 0.0, 0.0)
    try:
        m0 = float(value[0])
        m1 = float(value[1])
        m2 = float(value[2])
    except (TypeError, ValueError):
        return (0.0, 0.0, 0.0)
    return (m0, m1, m2)


# ---------- Core calc logic ----------

def compute_load_profile(
    archetype_id: Optional[str],
    *,
    expert_mode: bool = False,
    packs: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    packs = packs or []

    min_kwh = avg_kwh = max_kwh = 0.0
    peak_min = peak_avg = peak_max = 0.0

    # Archetype baseline
    if not expert_mode and archetype_id:
        arch = archetypes_db.get(archetype_id)
        if not arch:
            raise KeyError(f"Archetype '{archetype_id}' not found.")
        b_min, b_avg, b_max = _safe_band(arch.get("base_load_kwh_day"))
        p_min, p_avg, p_max = _safe_band(arch.get("base_peak_w"))

        min_kwh += b_min
        avg_kwh += b_avg
        max_kwh += b_max
        peak_min = max(peak_min, p_min)
        peak_avg = max(peak_avg, p_avg)
        peak_max = max(peak_max, p_max)

    # Packs
    for item in packs:
        group = item.get("group", "ac1p")
        key = item.get("key")
        usage_index = int(item.get("usage_index", 1))
        usage_index = max(0, min(usage_index, 2))

        pack_db = _get_pack_db(group)
        pack = pack_db.get(key)
        if not pack:
            continue

        k_min, k_avg, k_max = _safe_band(pack.get("kwh_day"))
        p_min, p_avg, p_max = _safe_band(pack.get("peak_w"))

        kwh_band = (k_min, k_avg, k_max)
        peak_band = (p_min, p_avg, p_max)

        kwh_val = kwh_band[usage_index]
        peak_val = peak_band[usage_index]

        if usage_index == 0:
            min_kwh += kwh_val
        elif usage_index == 1:
            avg_kwh += kwh_val
        else:
            max_kwh += kwh_val

        if usage_index == 0:
            peak_min = max(peak_min, peak_val)
        elif usage_index == 1:
            peak_avg = max(peak_avg, peak_val)
        else:
            peak_max = max(peak_max, peak_val)

        # broaden band when "typical" is chosen
        if usage_index == 1:
            min_kwh += k_min
            max_kwh += k_max
            peak_min = max(peak_min, p_min)
            peak_max = max(peak_max, p_max)

    # consistency
    if max_kwh == 0 and avg_kwh > 0:
        max_kwh = avg_kwh
    min_kwh = min(min_kwh, avg_kwh, max_kwh)
    max_kwh = max(max_kwh, avg_kwh, min_kwh)
    if avg_kwh < min_kwh:
        avg_kwh = min_kwh

    return {
        "archetype": archetype_id,
        "expert_mode": expert_mode,
        "daily_kwh_band": [round(min_kwh, 3), round(avg_kwh, 3), round(max_kwh, 3)],
        "peak_power_band_w": [
            int(round(peak_min)),
            int(round(peak_avg)),
            int(round(peak_max)),
        ],
    }


def compute_solar_profile(
    city: str,
    solar_wp: float,
    *,
    solar_db: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    solar_db = solar_db or solar_generation_db
    if not city:
        raise ValueError("City is required for solar calculation.")
    if city not in solar_db:
        raise KeyError(f"City '{city}' not found in solar_generation.json")

    solar_city = solar_db[city]
    summer_kwh_per_kwp = float(solar_city.get("summer_kwh_per_kwp", 0.0))
    winter_kwh_per_kwp = float(solar_city.get("winter_kwh_per_kwp", 0.0))
    kwp = float(solar_wp) / 1000.0

    summer_daily = summer_kwh_per_kwp * kwp
    winter_daily = winter_kwh_per_kwp * kwp
    avg_daily = summer_daily * 0.6 + winter_daily * 0.4

    return {
        "city": city,
        "wp": solar_wp,
        "kwp": kwp,
        "summer_daily_kwh": round(summer_daily, 3),
        "winter_daily_kwh": round(winter_daily, 3),
        "avg_daily_kwh": round(avg_daily, 3),
    }


def compute_savings_profile(
    avg_kwh_consumption: float,
    avg_kwh_solar: float,
    *,
    electricity_price_tl_per_kwh: float = 3.1,
    price_growth_rate: float = 0.25,
    horizon_years: int = 5,
    co2_kg_per_kwh: float = 0.45,
) -> Dict[str, Any]:
    avg_kwh_consumption = float(avg_kwh_consumption)
    avg_kwh_solar = float(avg_kwh_solar)

    daily_offset_kwh = min(avg_kwh_consumption, avg_kwh_solar)
    daily_co2_kg = daily_offset_kwh * co2_kg_per_kwh

    year1_price = electricity_price_tl_per_kwh
    year1_savings = daily_offset_kwh * year1_price * 365.0

    multi_year_savings = 0.0
    for year in range(horizon_years):
        price = electricity_price_tl_per_kwh * (1.0 + price_growth_rate) ** year
        multi_year_savings += daily_offset_kwh * price * 365.0

    yearly_co2 = daily_co2_kg * 365.0

    return {
        "daily_offset_kwh": round(daily_offset_kwh, 3),
        "year1_savings_tl": round(year1_savings, 2),
        "multi_year_savings_tl": round(multi_year_savings, 2),
        "yearly_co2_kg": round(yearly_co2, 2),
        "electricity_price_tl_per_kwh": electricity_price_tl_per_kwh,
        "price_growth_rate": price_growth_rate,
        "horizon_years": horizon_years,
        "co2_kg_per_kwh": co2_kg_per_kwh,
    }


def recommend_ecoflow_tiers(
    profile: Dict[str, Any],
    *,
    tiers_db: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    tiers_db = tiers_db or ecoflow_tiers_db

    daily_band = _safe_band(profile.get("daily_kwh_band", [0, 0, 0]))
    peak_band = _safe_band(profile.get("peak_power_band_w", [0, 0, 0]))

    typical_kwh = daily_band[1]
    peak_max = peak_band[2] or peak_band[1]

    required_capacity_wh = typical_kwh * 1000.0
    required_inverter_w = peak_max * 1.2 if peak_max else 0.0

    recommendations: List[Dict[str, Any]] = []

    for tier_id, tier_data in tiers_db.items():
        capacity_wh = tier_data.get("capacity_wh_total")
        inverter_w = tier_data.get("inverter_w_continuous")
        if capacity_wh is None or inverter_w is None:
            continue
        try:
            capacity_wh = float(capacity_wh)
            inverter_w = float(inverter_w)
        except (TypeError, ValueError):
            continue

        if capacity_wh >= required_capacity_wh and inverter_w >= required_inverter_w:
            tier_copy = dict(tier_data)
            tier_copy.setdefault("tier_id", tier_id)
            recommendations.append(tier_copy)

    recommendations.sort(key=lambda t: float(t.get("capacity_wh_total", 0)))

    if not recommendations:
        if "tier_2_comfort" in tiers_db:
            tier_copy = dict(tiers_db["tier_2_comfort"])
            tier_copy.setdefault("tier_id", "tier_2_comfort")
            recommendations.append(tier_copy)
        else:
            sorted_all = sorted(
                tiers_db.items(),
                key=lambda kv: float(kv[1].get("capacity_wh_total", 0)),
                reverse=True,
            )
            if sorted_all:
                tid, tdata = sorted_all[0]
                tier_copy = dict(tdata)
                tier_copy.setdefault("tier_id", tid)
                recommendations.append(tier_copy)

    return recommendations


def calculate_energy_profile(
    archetype_id: Optional[str],
    packs: Optional[List[str]] = None,
    *,
    expert_mode: bool = False,
    rich_packs: Optional[List[Dict[str, Any]]] = None,
    city: Optional[str] = None,
    solar_wp: Optional[float] = None,
) -> Dict[str, Any]:
    # Backwards-compat: if rich_packs not provided, assume AC1P packs with typical usage
    resolved_packs: List[Dict[str, Any]] = []

    if rich_packs:
        resolved_packs = list(rich_packs)
    elif packs:
        for key in packs:
            resolved_packs.append(
                {"group": "ac1p", "key": key, "usage_index": 1}
            )

    load_profile = compute_load_profile(
        archetype_id,
        expert_mode=expert_mode,
        packs=resolved_packs,
    )

    profile: Dict[str, Any] = {
        **load_profile,
        "selected_packs": [p.get("key") for p in resolved_packs],
    }

    if city and solar_wp and solar_wp > 0:
        solar_profile = compute_solar_profile(city, float(solar_wp))
        avg_kwh_consumption = load_profile["daily_kwh_band"][1]
        avg_kwh_solar = solar_profile["avg_daily_kwh"]
        savings_profile = compute_savings_profile(
            avg_kwh_consumption,
            avg_kwh_solar,
        )
        profile["solar"] = solar_profile
        profile["savings"] = savings_profile

    return profile
