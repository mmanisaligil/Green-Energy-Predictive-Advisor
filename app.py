from flask import Flask, render_template, request, jsonify
from engine import (
    calculate_energy_profile,
    recommend_ecoflow_tiers,
    archetypes_db,
    ecoflow_tiers_db,
    packs_ac1p_db,
    packs_ac3p_db,
    packs_dc12v_db,
    packs_dc24v_db,
    packs_dc48v_db,
    solar_generation_db,
)

app = Flask(__name__)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/init", methods=["GET"])
def api_init():
    packs = {
        "ac1p": packs_ac1p_db,
        "ac3p": packs_ac3p_db,
        "dc12": packs_dc12v_db,
        "dc24": packs_dc24v_db,
        "dc48": packs_dc48v_db,
    }
    return jsonify(
        {
            "archetypes": archetypes_db,
            "packs": packs,
            "tiers": ecoflow_tiers_db,
            "solar": solar_generation_db,
        }
    )


@app.route("/api/calculate", methods=["POST"])
def api_calculate():
    """
    Accepts either:
    - legacy: { "archetype": "...", "packs": ["lighting_basic", ...] }
    - rich:   {
          "archetype_id": "...",
          "expert_mode": false,
          "packs": [
            {"group": "ac1p", "key": "lighting_basic", "usage_index": 1},
            ...
          ],
          "city": "Istanbul",
          "solar_wp": 2000
      }
    """
    try:
        data = request.get_json() or {}

        archetype_id = data.get("archetype_id") or data.get("archetype")
        if not archetype_id:
            return jsonify({"error": "archetype_id (or archetype) is required."}), 400

        packs_raw = data.get("packs", [])
        rich_packs = None
        simple_packs = None

        if packs_raw:
            if isinstance(packs_raw[0], dict):
                rich_packs = packs_raw
            else:
                simple_packs = packs_raw

        expert_mode = bool(data.get("expert_mode", False))
        city = data.get("city")
        solar_wp = data.get("solar_wp")

        profile = calculate_energy_profile(
            archetype_id,
            simple_packs,
            expert_mode=expert_mode,
            rich_packs=rich_packs,
            city=city,
            solar_wp=solar_wp,
        )

        recommendations = recommend_ecoflow_tiers(profile)

        return jsonify({"profile": profile, "recommendations": recommendations})

    except (ValueError, KeyError) as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        print("Internal error in /api/calculate:", e)
        return jsonify({"error": "An internal error occurred."}), 500


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=8000)
