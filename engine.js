// --- engine.js: 兵站・追跡・クラッシュ防止修正版 ---

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

function addHate(f1, f2, v) { if(f1===f2||f1==='independent'||f2==='independent') return; if(!GameState.hateMatrix[f1]) GameState.hateMatrix[f1]={}; GameState.hateMatrix[f1][f2]=(GameState.hateMatrix[f1][f2]||0)+v; }
function addFriendship(f1, f2, v) { if(f1===f2||f1==='independent'||f2==='independent') return; if(!GameState.friendshipMatrix[f1]) GameState.friendshipMatrix[f1]={}; GameState.friendshipMatrix[f1][f2]=(GameState.friendshipMatrix[f1][f2]||0)+v; }
function areAllies(f1, f2) { return window.getAllianceLevel(f1, f2) > 0; }

const gameEngine = {
    log: function(m) {
        const c = document.getElementById('log-console');
        const e = document.createElement('div'); e.className = 'log-entry';
        e.innerHTML = `<span class="log-month">[${GameState.year}/${GameState.month}/${GameState.day}]</span> ${m}`;
        c.prepend(e);
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
        try {
            this.tickDay();
        } catch (e) {
            console.error("Game Loop Error:", e);
            this.log("<span style='color:red;'>エラーにより時間が停止しました。F12で詳細を確認してください。</span>");
            GameState.isPaused = true;
            return;
        }
        setTimeout(() => this.gameLoop(), parseInt(document.getElementById('speedSlider').value));
    },

    tickDay: function() {
        if (GameState.day === 1) this.runAI();
        const pIdx = GameState.priceIndex;

        // 城・部隊の消費
        Object.values(GameState.castles).forEach(c => {
            if(c.faction === 'independent') return;
            c.food = Math.max(0, c.food - Math.floor((c.troops / 100) * 1 * pIdx));
            if (c.food <= 0) c.troops = Math.max(0, Math.floor(c.troops * 0.95));
        });
        GameState.armies.forEach(a => {
            a.food = Math.max(0, a.food - Math.floor((a.troops / 100) * 3 * pIdx));
            if (a.food <= 0) {
                a.troops = Math.max(0, a.troops - Math.max(1, Math.floor(a.troops * 0.05)));
                if(GameState.day % 10 === 0) window.showFloatingText(a.pos.lat, a.pos.lng, "飢餓");
            }
        });

        // タスク進行
        for (let i = GameState.tasks.length - 1; i >= 0; i--) {
            let t = GameState.tasks[i]; t.daysLeft--;
            if (t.daysLeft <= 0) {
                const c = GameState.castles[t.castleId];
                if (c && c.faction === t.faction) {
                    if (t.type === 'agriculture') c.currentKokudaka += 2000;
                    else if (t.type === 'commerce') c.commerce += 50;
                    else if (t.type === 'repair') c.siegeHP = c.maxSiegeHP;
                    else if (t.type === 'defense') { c.defense += 20; c.maxSiegeHP = c.defense * 10; c.siegeHP = c.maxSiegeHP; }
                }
                GameState.tasks.splice(i, 1);
            }
        }

        // 移動
        GameState.armies.forEach(a => {
            if (a.troops <= 0) return;
            if (a.targetArmyId) {
                let ta = GameState.armies.find(x => x.id === a.targetArmyId);
                if (!ta || ta.troops <= 0) { a.targetArmyId = null; a.pathQueue = []; a.task = 'hold'; }
                else if (GameState.day % 3 === 0) {
                    let r = window.findShortestPath(getClosestNode(a.pos).id, getClosestNode(ta.pos).id);
                    if (r) a.pathQueue = r;
                }
            }
            let n = a.pathQueue[0], tLat, tLng, spd = 1.0;
            if (n) { let i = window.rawNodes.find(x => x.id === n.nodeId); tLat = i.lat; tLng = i.lng; spd = n.speedMod; }
            else if (a.targetLatLng) { tLat = a.targetLatLng.lat; tLng = a.targetLatLng.lng; }
            else if (a.targetArmyId) { let ta = GameState.armies.find(x => x.id === a.targetArmyId); tLat = ta.pos.lat; tLng = ta.pos.lng; }
            else return;

            let d = map.distance(L.latLng(a.pos.lat, a.pos.lng), L.latLng(tLat, tLng)) / 1000;
            let move = (a.task==='transport'?1.5:3) * spd;
            if (move >= d) {
                a.pos = { lat: tLat, lng: tLng };
                if (a.pathQueue.length > 0) a.pathQueue.shift();
                else if (a.targetLatLng) { a.targetLatLng = null; a.task = 'hold'; }
            } else {
                let r = move / d; a.pos.lat += (tLat - a.pos.lat) * r; a.pos.lng += (tLng - a.pos.lng) * r;
            }
        });

        // 合流
        for (let i = 0; i < GameState.armies.length; i++) {
            for (let j = i + 1; j < GameState.armies.length; j++) {
                let a1 = GameState.armies[i], a2 = GameState.armies[j];
                if (a1.troops <= 0 || a2.troops <= 0 || a1.faction !== a2.faction) continue;
                if (map.distance(L.latLng(a1.pos), L.latLng(a2.pos)) < 500) {
                    if (a1.task==='transport' || a2.task==='transport') {
                        let t = a1.task==='transport'?a1:a2, r = a1.task==='transport'?a2:a1;
                        r.troops += t.troops; r.gold += t.gold; r.food += t.food; t.troops = 0;
                    } else if (!a1.targetNodeId && !a2.targetNodeId) {
                        if (a1.troops >= a2.troops) { a1.troops+=a2.troops; a1.gold+=a2.gold; a1.food+=a2.food; a2.troops=0; }
                        else { a2.troops+=a1.troops; a2.gold+=a1.gold; a2.food+=a1.food; a1.troops=0; }
                    }
                }
            }
        }

        this.resolveBattlesInTick();
        GameState.armies = GameState.armies.filter(a => a.troops > 0);
        updateDynamicVisuals(); updateUI(); GameState.day++;
        if (GameState.day > 30) { GameState.day = 1; this.finalizeMonth(); }
    },

    resolveBattlesInTick: function() {
        // 攻城戦の計算
        GameState.armies.forEach(army => {
            if (army.troops <= 0) return;
            const node = getClosestNode(army.pos);
            if (!node || node.type === "5" || node.type === "0") return;
            const castle = GameState.castles[node.id]; if(!castle) return;

            if (map.distance(L.latLng(army.pos), L.latLng(node.lat, node.lng)) < 200) {
                if (castle.faction === army.faction) {
                    if (army.task === 'transport' || (army.pathQueue.length === 0 && !army.targetLatLng && !army.targetArmyId)) {
                        castle.troops += army.troops; castle.gold += army.gold; castle.food += army.food; army.troops = 0;
                    }
                } else if (!areAllies(army.faction, castle.faction)) {
                    // 城壁削り
                    if (castle.siegeHP > 0) {
                        let dmg = Math.floor(army.troops * 0.05); castle.siegeHP -= dmg;
                        army.troops -= Math.floor(castle.troops * 0.02);
                        if(GameState.day % 5 === 0) window.showFloatingText(node.lat, node.lng, "攻城中");
                    } else {
                        // 占領
                        if (army.troops > castle.troops * 1.5) {
                            castle.faction = army.faction; castle.troops = Math.floor(army.troops * 0.6);
                            castle.gold += army.gold; castle.food += army.food; army.troops = 0; castle.siegeHP = castle.maxSiegeHP * 0.2;
                            this.log(`🎊 ${castle.name} を占領！`);
                        }
                    }
                }
            }
        });

        // 野戦の計算
        for(let i=0; i<GameState.armies.length; i++) {
            for(let j=i+1; j<GameState.armies.length; j++) {
                let a1 = GameState.armies[i], a2 = GameState.armies[j];
                if (a1.troops <= 0 || a2.troops <= 0 || areAllies(a1.faction, a2.faction)) continue;
                if (map.distance(L.latLng(a1.pos), L.latLng(a2.pos)) < 1000) {
                    let p1 = a1.troops * (a1.task==='transport'?0.3:1.0), p2 = a2.troops * (a2.task==='transport'?0.3:1.0);
                    if (p1 > p2) { a2.troops -= Math.floor(p1*0.2); a1.troops -= Math.floor(p2*0.1); }
                    else { a1.troops -= Math.floor(p2*0.2); a2.troops -= Math.floor(p1*0.1); }
                    
                    // 🌟 クラッシュ防止済みの支援射撃チェック
                    [a1, a2].forEach(target => {
                        const nearby = getClosestNode(target.pos);
                        if (nearby && nearby.type !== "5" && nearby.type !== "0") { // 城ノードのみチェック
                            const castle = GameState.castles[nearby.id];
                            if (castle && areAllies(castle.faction, (target===a1?a2:a1).faction)) {
                                target.troops -= Math.floor(castle.troops * 0.02);
                            }
                        }
                    });
                }
            }
        }
    },

    runAI: function() {
        const pIdx = GameState.priceIndex;
        Object.values(GameState.castles).forEach(c => {
            if(c.faction === 'independent' || (GameState.playerFaction && c.faction === GameState.playerFaction)) return;
            // 簡易AI: 兵糧があれば近くの敵城へ
            if (c.troops > 1000 && c.food > 5000) {
                let target = Object.values(GameState.castles).find(t => t.faction !== c.faction && !areAllies(c.faction, t.faction));
                if (target) {
                    let r = findShortestPath(c.id, target.id);
                    if (r) {
                        let a = window.deployArmy(c.id, 800, true, 'attack', 0, 3000);
                        if(a) { a.pathQueue = r; a.targetNodeId = target.id; }
                    }
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
            c.food = Math.min(c.food, c.currentKokudaka * 5);
            let max = getMaxTroops(c); if(c.troops < max) c.troops += Math.floor(max * 0.05);
        });
        updateUI(); drawMap();
    }
};
