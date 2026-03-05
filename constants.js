const EdgeMultipliers = { "road_l": 1.2, "road_m": 1.0, "road_s": 0.8, "pass_l": 0.6, "pass_m": 0.5, "pass_s": 0.4, "river_l": 1.5, "river_m": 1.2, "river_s": 0.9, "sea": 1.5, "bridge": 0.8, "default": 1.0 };

let FactionMaster = {
    "player": { name: "プレイヤー", color: "#3498db" },
    "independent": { name: "国人衆(中立)", color: "#95a5a6" }
};

// 大名の個性を取得する関数
function getFactionTraits(factionId) {
    const defaultTraits = {
        aggression: 1.0,
        wait_threshold: 0.8,
        combat_bonus: 1.0,
        defense_bonus: 1.0,
        recruit_bonus: 1.0
    };
    if (FactionMaster[factionId] && FactionMaster[factionId].traits) {
        return { ...defaultTraits, ...FactionMaster[factionId].traits };
    }
    return defaultTraits;
}

function getMaxTroops(castle) {
    return Math.floor(castle.currentKokudaka * 0.025 + castle.commerce * 0.5 + castle.defense * 2);
}
