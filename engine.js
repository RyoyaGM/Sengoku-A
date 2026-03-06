// --- engine.js: UIフィルタ・不定期出陣・警戒レベル統合版 ---

const GameState = {
    isLoaded: false, hasStarted: false, isPaused: true,
    year: 1560, month: 1, day: 1, castles: {}, armies: [], armyIdCounter: 1,
    playerFaction: null, alliances: {}, hateMatrix: {}, friendshipMatrix: {},
    priceIndex: 1.0, tasks: [] 
};

window.getAllianceLevel = function(f1, f2) {
    if (f1 === f2) return 3;
    return GameState.alliances[`${f1}-${f2}`] || GameState.alliances[`${f2}-${f1}`] || 0;
};
window.getDiplomacyScore = function(f1, f2) {
    return (GameState.friendshipMatrix[f1]?.[f2] || 0) - (GameState.hateMatrix[f1]?.[f2] || 0);
};

window.addHate = function(f1, f2, v) { 
    if(f1===f2||f1==='independent'||f2==='independent') return; 
    if(!GameState.hateMatrix[f1]) GameState.hateMatrix[f1]={}; 
    GameState.hateMatrix[f1][f2]=(GameState.hateMatrix[f1][f2]||0)+v; 
};
window.addFriendship = function(f1, f2, v) { 
    if(f1===f2||f1==='independent'||f2==='independent') return; 
    if(!GameState.friendshipMatrix[f1]) GameState.friendshipMatrix[f1]={}; 
    GameState.friendshipMatrix[f1][f2]=(GameState.friendshipMatrix[f1][f2]||0)+v; 
};
window.areAllies = function(f1, f2) { return window.getAllianceLevel(f1, f2) > 0; };

const gameEngine = {
    // 🌟 ログのカテゴリ化
    log: function(m, type = 'system') {
        const c = document.getElementById('log-console');
        const e = document.createElement('div');
        e.className = `log-entry log-${type}`;
        e.innerHTML = `<span class="log-month">[${GameState.year}/${GameState.month}/${GameState.day}]</span> ${m}`;
        
        // フィルタ状態に合わせる
        if (currentLogFilter !== 'all' && currentLogFilter !== type) e.style.display = 'none';
        
        c.prepend(e);
        if (c.childNodes.length > 100) c.removeChild(c.lastChild); // パフォーマンス維持
    },

    toggleTime: function() {
        if (!GameState.hasStarted) return;
        GameState.isPaused = !GameState.isPaused;
        const b = document.getElementById('btnToggleTime');
        b.innerText = GameState.isPaused ? '▶ 時間を進める' : '⏸ 一時停止';
        if (!GameState.isPaused) this.gameLoop();
    },

    gameLoop: function() {
        if (GameState.isPaused || !GameState.hasStarted) return;
        try { this.tickDay(); } catch (e) { console.error(e); GameState.isPaused = true; return; }
        setTimeout(() => this.gameLoop(), parseInt(document.getElementById('speedSlider').value));
    },

    tickDay: function() {
        // 🌟 1日限定を撤廃。毎日AIが不定期に判断する。
        this.runAI();
        
        const pIdx = GameState.priceIndex;
        const isWinter = (GameState.month === 12 || GameState.month <= 2);

        // フリーズ回避
        GameState.armies.forEach(a => {
            if (a.troops <= 0) return;
            if (a.targetNodeId && a.task === 'attack') {
                let targetCastle = GameState.castles[a.targetNodeId];
                if (targetCastle && window.areAllies(a.faction, targetCastle.faction)) {
                    a.task = 'hold'; a.targetNodeId = null; a.pathQueue = [];
                }
            }
        });

        // 兵糧消費
        Object.values(GameState.castles).forEach(c => {
            if(c.faction === 'independent') return;
            c.food -= Math.floor((c.troops / 100) * 0.3 * pIdx);
            if (c.food <= 0) { c.food = 0; c.troops = Math.max(0, Math.floor(c.troops * 0.95)); }
        });

        GameState.armies.forEach(a => {
            if (a.troops <= 0) return;
            let node = getClosestNode(a.pos);
            let isAlly = (node && node.type !== "5" && node.type !== "0") ? window.areAllies(a.faction, GameState.castles[node.id].faction) : false;
            let rate = a.task === 'attack' && !a.pathQueue.length ? 5.0 : (isAlly ? 3.0 : 4.0);
            a.food -= Math.floor((a.troops / 100) * rate * pIdx);
            if (a.food <= 0) { a.food = 0; a.troops = Math.max(0, a.troops - Math.max(1, Math.floor(a.troops * 0.05))); }

            // 自動撤退
            if (a.task !== 'retreat' && a.food < (a.troops / 100) * 300) {
                let closest = null; let minD = Infinity;
                Object.values(GameState.castles).forEach(c => {
                    if (window.areAllies(c.faction, a.faction)) {
                        let d = map.distance(L.latLng(a.pos), L.latLng(window.rawNodes.find(n=>n.id===c.id).lat, window.rawNodes.find(n=>n.id===c.id).lng));
                        if(d < minD){ minD = d; closest = c; }
                    }
                });
                if (closest) { a.task = 'retreat'; a.targetNodeId = closest.id; a.pathQueue = window.findShortestPath(getClosestNode(a.pos).id, closest.id) || []; }
            }
        });

        // 移動
        GameState.armies.forEach(a => {
            if (a.troops <= 0) return;
            let tLat, tLng, spd = 1.0;
            if (a.targetArmyId) {
                let ta = GameState.armies.find(x => x.id === a.targetArmyId);
                if (!ta || ta.troops <= 0) { a.targetArmyId = null; return; }
                tLat = ta.pos.lat; tLng = ta.pos.lng;
            } else if (a.pathQueue.length > 0) {
                let n = window.rawNodes.find(x => x.id === a.pathQueue[0].nodeId);
                tLat = n.lat; tLng = n.lng; spd = a.pathQueue[0].speedMod;
            } else if (a.targetLatLng) { tLat = a.targetLatLng.lat; tLng = a.targetLatLng.lng; }
            else return;

            let move = (a.task === 'retreat' ? 7.8 : 6.0) * (isWinter ? 0.5 : 1.0) * spd * Math.max(0.5, 1.2 - (a.troops/20000));
            let d = map.distance(L.latLng(a.pos), L.latLng(tLat, tLng)) / 1000;
            if (move >= d) { a.pos = { lat: tLat, lng: tLng }; if(a.pathQueue.length > 0) a.pathQueue.shift(); }
            else { let r = move / d; a.pos.lat += (tLat - a.pos.lat) * r; a.pos.lng += (tLng - a.pos.lng) * r; }
        });

        this.resolveBattlesInTick();
        GameState.armies = GameState.armies.filter(a => a.troops > 0);
        updateDynamicVisuals(); updateUI(); GameState.day++;
        if (GameState.day > 30) { GameState.day = 1; this.finalizeMonth(); }
    },

    resolveBattlesInTick: function() {
        GameState.armies.forEach(army => {
            if (army.troops <= 0) return;
            const node = getClosestNode(army.pos);
            if (!node || node.type === "5" || node.type === "0") return;
            const castle = GameState.castles[node.id]; if(!castle) return;
            if (map.distance(L.latLng(army.pos), L.latLng(node.lat, node.lng)) < 200) {
                if (castle.faction === army.faction) {
                    if (army.task === 'transport' || !army.pathQueue.length) { castle.troops += army.troops; castle.gold += army.gold; castle.food += army.food; army.troops = 0; }
                } else if (!window.areAllies(army.faction, castle.faction)) {
                    if (castle.siegeHP > 0) { castle.siegeHP -= Math.floor(army.troops * 0.05); army.troops -= Math.floor(castle.troops * 0.02); }
                    else if (army.troops > castle.troops * 1.5) {
                        army.gold += castle.gold; army.food += castle.food;
                        castle.faction = army.faction; castle.troops = Math.floor(army.troops * 0.6);
                        army.troops = 0; castle.siegeHP = castle.maxSiegeHP * 0.2;
                        this.log(`占領: ${castle.name} (${FactionMaster[castle.faction].name})`, 'combat');
                    }
                }
            }
        });
        // 野戦
        for(let i=0; i<GameState.armies.length; i++) {
            for(let j=i+1; j<GameState.armies.length; j++) {
                let a1 = GameState.armies[i], a2 = GameState.armies[j];
                if (a1.troops <= 0 || a2.troops <= 0 || window.areAllies(a1.faction, a2.faction)) continue;
                if (map.distance(L.latLng(a1.pos), L.latLng(a2.pos)) < 1000) {
                    let p1 = a1.troops, p2 = a2.troops;
                    if(p1 > p2) { a2.troops -= Math.floor(p1*0.2); a1.troops -= Math.floor(p2*0.1); }
                    else { a1.troops -= Math.floor(p2*0.2); a2.troops -= Math.floor(p1*0.1); }
                    if(GameState.day % 5 === 0) window.showFloatingText(a1.pos.lat, a1.pos.lng, "激突");
                }
            }
        }
    },

    runAI: function() {
        // 🌟 毎月1日ではなく、毎日確率（3%）で各城が判断を行う
        Object.values(GameState.castles).forEach(c => {
            if(c.faction === 'independent' || (GameState.playerFaction && c.faction === GameState.playerFaction)) return;
            if(Math.random() > 0.03) return; // 毎日約3%の城が「今、動くべきか」を考える

            let deployTroops = Math.floor(c.troops * 0.7);
            if (deployTroops < 500 || c.food < (deployTroops/100)*4000) return;

            let candidates = Object.values(GameState.castles)
                .filter(t => t.faction !== c.faction && !window.areAllies(c.faction, t.faction))
                .map(t => {
                    let d = map.distance(L.latLng(window.rawNodes.find(n=>n.id===c.id).lat, window.rawNodes.find(n=>n.id===c.id).lng), L.latLng(window.rawNodes.find(n=>n.id===t.id).lat, window.rawNodes.find(n=>n.id===t.id).lng));
                    return { castle: t, dist: d };
                }).sort((a,b)=>a.dist - b.dist).slice(0,3);

            if(candidates.length > 0) {
                let target = candidates[0].castle;
                let route = window.findShortestPath(c.id, target.id);
                if(route) {
                    let a = window.deployArmy(c.id, deployTroops, true, 'attack', 0, Math.floor(c.food*0.5));
                    if(a) { a.pathQueue = route; a.targetNodeId = target.id; this.log(`${FactionMaster[c.faction].name} が ${target.name} へ出陣`, 'ai'); }
                }
            }
        });
    },

    finalizeMonth: function() {
        GameState.month++; if (GameState.month > 12) { GameState.month = 1; GameState.year++; }
        const isHarvest = (GameState.month === 9), pIdx = GameState.priceIndex;
        Object.values(GameState.castles).forEach(c => {
            if (c.faction === "independent") return;
            c.gold += Math.floor(c.commerce * 0.2 * pIdx);
            if(isHarvest) c.food += Math.floor(c.currentKokudaka * 1.0 * pIdx);
            c.food = Math.min(c.food, c.currentKokudaka * 15);
            let max = getMaxTroops(c); if(c.troops < max) c.troops += Math.floor(max * 0.05);
            
            // 摩擦
            window.graph[c.id].forEach(edge => {
                let nc = GameState.castles[edge.to];
                if(nc && nc.faction !== 'independent' && nc.faction !== c.faction && !window.areAllies(c.faction, nc.faction)) window.addHate(c.faction, nc.faction, 2);
            });
        });

        // 警戒レベル・包囲網 (簡略版を維持)
        let factionKoku = {}; let total = 0;
        Object.values(GameState.castles).forEach(c => { if(c.faction!=='independent'){ factionKoku[c.faction] = (factionKoku[c.faction]||0)+c.currentKokudaka; total += c.currentKokudaka; }});
        Object.keys(factionKoku).forEach(f => {
            if(factionKoku[f] / total > 0.2) { // 20%シェアで簡易警戒
                Object.keys(factionKoku).forEach(other => { if(f!==other) window.addHate(other, f, 10); });
            }
        });

        // 外交更新
        const facs = Object.keys(FactionMaster).filter(f=>f!=='independent');
        GameState.alliances = {};
        for(let i=0; i<facs.length; i++) {
            for(let j=i+1; j<facs.length; j++) {
                let s = (window.getDiplomacyScore(facs[i], facs[j]) + window.getDiplomacyScore(facs[j], facs[i])) / 2;
                if(s >= 150) GameState.alliances[`${facs[i]}-${facs[j]}`] = 1;
            }
        }
        updateUI(); drawMap();
    }
};
