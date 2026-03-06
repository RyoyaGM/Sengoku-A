// --- engine.js: 地形・状態による可変兵糧消費と自動撤退の統合版 ---

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
        const isWinter = (GameState.month === 12 || GameState.month <= 2);

        // 🌟 城の消費（駐屯兵: 0.3/日）
        Object.values(GameState.castles).forEach(c => {
            if(c.faction === 'independent') return;
            c.food -= Math.floor((c.troops / 100) * 0.3 * pIdx);
            if (c.food <= 0) { c.food = 0; c.troops = Math.max(0, Math.floor(c.troops * 0.95)); }
        });

        // 🌟 部隊の消費（地勢と行動状態による変化）と退却判定
        GameState.armies.forEach(a => {
            if (a.troops <= 0) return;
            let node = getClosestNode(a.pos);
            let isAllyTerritory = (node && node.type !== "5" && node.type !== "0") ? areAllies(a.faction, GameState.castles[node.id].faction) : false;
            
            let baseRate = 3.0; // デフォルト行軍
            if (a.task === 'retreat') baseRate = isAllyTerritory ? 2.0 : 3.0;
            else if (a.task === 'hold') baseRate = isAllyTerritory ? 1.0 : 2.0;
            else baseRate = isAllyTerritory ? 3.0 : 4.0;
            
            // 包囲・交戦中（目標に到着して止まっている場合）
            if (a.task === 'attack' && !a.pathQueue.length && !a.targetLatLng && !a.targetArmyId) baseRate = 5.0;

            a.food -= Math.floor((a.troops / 100) * baseRate * pIdx);
            if (a.food <= 0) {
                a.food = 0;
                a.troops = Math.max(0, a.troops - Math.max(1, Math.floor(a.troops * 0.05)));
                if(GameState.day % 10 === 0) window.showFloatingText(a.pos.lat, a.pos.lng, "飢餓", "#e74c3c");
            }

            // 🌟 帰還限界点（退却）の判定
            if (a.task !== 'retreat') {
                let closestAlly = null; let minDist = Infinity;
                Object.values(GameState.castles).forEach(c => {
                    if (areAllies(c.faction, a.faction)) {
                        let cn = window.rawNodes.find(n => n.id === c.id);
                        let d = map.distance(L.latLng(a.pos.lat, a.pos.lng), L.latLng(cn.lat, cn.lng));
                        if (d < minDist) { minDist = d; closestAlly = c; }
                    }
                });
                if (closestAlly) {
                    let cn = window.rawNodes.find(n => n.id === closestAlly.id);
                    let route = window.findShortestPath(getClosestNode(a.pos).id, cn.id);
                    let days = route ? Math.ceil(route.reduce((sum, r) => sum + (r.dist / r.speedMod), 0) / 6.0) : 0;
                    let reqFood = Math.floor((a.troops / 100) * 3 * pIdx * (days + 5)); // 帰還までの日数＋5日分の余裕
                    if (a.food < reqFood) {
                        a.task = 'retreat';
                        a.pathQueue = route || [];
                        a.targetNodeId = closestAlly.id;
                        a.targetArmyId = null;
                        a.targetLatLng = null;
                        if(a.faction === GameState.playerFaction) this.log(`<span style="color:#e74c3c;">⚠️ 兵糧不足！部隊が ${closestAlly.name} へ退却を開始しました！</span>`);
                    }
                }
            }
        });

        // 工期タスク進行
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

        // 🌟 移動ロジック（兵力による速度の変化）
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

            // 兵数による速度ペナルティ（大軍ほど遅い）
            let speedModByTroops = Math.max(0.5, Math.min(1.2, 1.2 - (a.troops / 20000)));
            let baseSpd = 6.0;
            if (a.task === 'transport') baseSpd = 3.0; // 輸送隊は遅い
            else if (a.task === 'retreat') baseSpd = 7.8; // 退却は速い
            
            let move = baseSpd * speedModByTroops * (isWinter ? 0.5 : 1.0) * spd;
            let d = map.distance(L.latLng(a.pos.lat, a.pos.lng), L.latLng(tLat, tLng)) / 1000;
            
            if (move >= d) {
                a.pos = { lat: tLat, lng: tLng };
                if (a.pathQueue.length > 0) a.pathQueue.shift();
                else if (a.targetLatLng) { a.targetLatLng = null; a.task = 'hold'; }
            } else {
                let r = d === 0 ? 0 : move / d; 
                a.pos.lat += (tLat - a.pos.lat) * r; a.pos.lng += (tLng - a.pos.lng) * r;
            }
        });

        // 🌟 合流（退却中は合流しない、目標が城の場合は包囲を意図しているため合流しない）
        for (let i = 0; i < GameState.armies.length; i++) {
            for (let j = i + 1; j < GameState.armies.length; j++) {
                let a1 = GameState.armies[i], a2 = GameState.armies[j];
                if (a1.troops <= 0 || a2.troops <= 0 || a1.faction !== a2.faction) continue;
                if (a1.task === 'retreat' || a2.task === 'retreat') continue; // 退却中は無視

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
        if (typeof window.updateDynamicVisuals === 'function') window.updateDynamicVisuals(); 
        updateUI(); GameState.day++;
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
                    army.pathQueue = []; army.targetLatLng = null; army.targetArmyId = null;
                    if (castle.siegeHP > 0) {
                        let dmg = Math.floor(army.troops * 0.05); castle.siegeHP -= dmg;
                        army.troops -= Math.floor(castle.troops * 0.02);
                        if(GameState.day % 5 === 0) window.showFloatingText(node.lat, node.lng, "攻城");
                    } else {
                        if (army.troops > castle.troops * 1.5) {
                            army.gold += castle.gold; army.food += castle.food; // 略奪
                            castle.gold = 0; castle.food = 0;
                            castle.faction = army.faction; castle.troops = Math.floor(army.troops * 0.6);
                            army.troops = 0; castle.siegeHP = castle.maxSiegeHP * 0.2;
                            this.log(`🎊 ${FactionMaster[army.faction].name} が ${castle.name} を占領！`);
                            drawMap();
                        }
                    }
                }
            }
        });

        // 野戦と略奪の計算
        for(let i=0; i<GameState.armies.length; i++) {
            for(let j=i+1; j<GameState.armies.length; j++) {
                let a1 = GameState.armies[i], a2 = GameState.armies[j];
                if (a1.troops <= 0 || a2.troops <= 0 || areAllies(a1.faction, a2.faction)) continue;
                
                if (map.distance(L.latLng(a1.pos), L.latLng(a2.pos)) < 1000) {
                    let p1 = a1.troops * (a1.task==='transport'?0.3:1.0);
                    let p2 = a2.troops * (a2.task==='transport'?0.3:1.0);
                    
                    let winner = null, loser = null;
                    if (p1 > p2) { a2.troops -= Math.floor(p1*0.2); a1.troops -= Math.floor(p2*0.1); if(a2.troops<=10){a2.troops=0; winner=a1; loser=a2;} }
                    else { a1.troops -= Math.floor(p2*0.2); a2.troops -= Math.floor(p1*0.1); if(a1.troops<=10){a1.troops=0; winner=a2; loser=a1;} }
                    
                    if (winner && loser) {
                        let sG = Math.floor(loser.gold * 0.7); let sF = Math.floor(loser.food * 0.7);
                        winner.gold += sG; winner.food += sF; loser.gold = 0; loser.food = 0;
                    }
                    
                    a1.pathQueue = []; a2.pathQueue = []; a1.targetLatLng = null; a2.targetLatLng = null;
                    addHate(a1.faction, a2.faction, 10); addHate(a2.faction, a1.faction, 10);
                    
                    // 支援射撃（城ノードのみ）
                    [a1, a2].forEach(target => {
                        const nearby = getClosestNode(target.pos);
                        if (nearby && nearby.type !== "5" && nearby.type !== "0") { 
                            const castle = GameState.castles[nearby.id];
                            if (castle && areAllies(castle.faction, (target===a1?a2:a1).faction) && castle.faction !== target.faction) {
                                target.troops = Math.max(0, target.troops - Math.floor(castle.troops * 0.02));
                            }
                        }
                    });
                }
            }
        }
    },

    runAI: function() {
        const pIdx = GameState.priceIndex;

        // 1. 援軍要請
        Object.values(GameState.castles).forEach(castle => {
            if (castle.faction === 'independent') return;
            let isAttacked = GameState.armies.some(a => a.faction !== castle.faction && a.targetNodeId === castle.id);
            if (isAttacked) {
                Object.keys(FactionMaster).forEach(allyFac => {
                    let level = window.getAllianceLevel(castle.faction, allyFac);
                    if (level >= 2 && castle.gold >= Math.floor(100 * pIdx) && Math.random() < (level === 3 ? 0.9 : 0.5)) {
                        castle.gold -= Math.floor(100 * pIdx);
                        let bAlly = null, minD = Infinity;
                        const cN = window.rawNodes.find(n => n.id === castle.id);
                        Object.values(GameState.castles).forEach(ac => {
                            if (ac.faction === allyFac && ac.troops > 1000) {
                                let aN = window.rawNodes.find(n => n.id === ac.id);
                                let d = map.distance(L.latLng(cN.lat, cN.lng), L.latLng(aN.lat, aN.lng));
                                if (d < 40000 && d < minD) { minD = d; bAlly = ac; }
                            }
                        });
                        if (bAlly) {
                            let r = findShortestPath(bAlly.id, castle.id);
                            if (r) {
                                let a = window.deployArmy(bAlly.id, Math.floor(bAlly.troops*0.5), true, 'attack', 0, Math.floor(bAlly.food*0.3));
                                if(a) { a.pathQueue = r; a.targetNodeId = castle.id; this.log(`<span class="log-ai">🤝 ${FactionMaster[allyFac].name} が援軍を派遣！</span>`); }
                            }
                        }
                    }
                });
            }
        });

        // 🌟 2. ターゲット選定と厳密な兵糧計算
        Object.values(GameState.castles).forEach(c => {
            if(c.faction === 'independent' || (GameState.playerFaction && c.faction === GameState.playerFaction)) return;
            
            let deployTroops = Math.floor(c.troops * 0.7);
            if (deployTroops < 500) return;

            const cN = window.rawNodes.find(n => n.id === c.id);
            
            let candidates = Object.values(GameState.castles)
                .filter(t => t.faction !== c.faction && !areAllies(c.faction, t.faction))
                .map(t => {
                    let tN = window.rawNodes.find(n => n.id === t.id);
                    let dist = map.distance(L.latLng(cN.lat, cN.lng), L.latLng(tN.lat, tN.lng));
                    return { castle: t, dist: dist };
                })
                .sort((a, b) => a.dist - b.dist)
                .slice(0, 5);

            let bestTarget = null; let bestScore = -Infinity; let bestFoodReq = 0;
            candidates.forEach(cand => {
                let targetCastle = cand.castle;
                let route = findShortestPath(c.id, targetCastle.id);
                if (!route) return;

                // 往復にかかる日数を計算（約6.0の速度をベースに）
                let totalCost = route.reduce((sum, r) => sum + (r.dist / r.speedMod), 0);
                let daysToTarget = Math.ceil(totalCost / 6.0);
                
                // 必要兵糧 ＝ (往復日数 + 攻城30日 + 予備10日) × 敵地消費レート(4)
                let estFood = Math.floor((deployTroops / 100) * 4.0 * pIdx * (daysToTarget * 2 + 40));
                
                // 蔵の兵糧が足りないなら除外
                if (c.food < estFood) return;

                let enemyPower = targetCastle.troops + (targetCastle.siegeHP * 0.5);
                if (deployTroops < enemyPower * 1.2 && targetCastle.faction !== 'independent') return;

                let score = (10000 / (cand.dist + 1)) - enemyPower;
                if (score > bestScore) { bestScore = score; bestTarget = { id: targetCastle.id, route: route }; bestFoodReq = estFood; }
            });

            if (bestTarget) {
                let a = window.deployArmy(c.id, deployTroops, true, 'attack', 0, bestFoodReq);
                if (a) {
                    a.pathQueue = bestTarget.route; a.targetNodeId = bestTarget.id;
                    this.log(`<span class="log-ai">【出陣】${FactionMaster[c.faction].name} が ${GameState.castles[bestTarget.id].name} へ侵攻開始！</span>`);
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
            c.food = Math.min(c.food, c.currentKokudaka * 15); // 上限を石高の15倍に
            let max = getMaxTroops(c); if(c.troops < max) c.troops += Math.floor(max * 0.05);
        });

        for (let f1 in GameState.hateMatrix) { for (let f2 in GameState.hateMatrix[f1]) { GameState.hateMatrix[f1][f2] = Math.max(0, GameState.hateMatrix[f1][f2] - 10); } }
        for (let f1 in GameState.friendshipMatrix) { for (let f2 in GameState.friendshipMatrix[f1]) { GameState.friendshipMatrix[f1][f2] = Math.max(0, GameState.friendshipMatrix[f1][f2] - 5); } }
        
        const factions = Object.keys(FactionMaster).filter(f => f !== 'independent');
        GameState.alliances = {};
        for(let i=0; i<factions.length; i++) {
            for(let j=i+1; j<factions.length; j++) {
                let f1 = factions[i], f2 = factions[j];
                let mutualScore = (window.getDiplomacyScore(f1, f2) + window.getDiplomacyScore(f2, f1)) / 2;
                let level = 0;
                if (mutualScore >= 800) level = 3;
                else if (mutualScore >= 500) level = 2;
                else if (mutualScore >= 300) level = 1;
                
                if (level > 0) GameState.alliances[`${f1}-${f2}`] = level;
            }
        }

        if(typeof window.updateStatsTable === 'function' && !document.getElementById('stats-modal').classList.contains('modal-hidden')) window.updateStatsTable();
        updateUI(); drawMap();
    }
};
