// --- engine.js: 非カレンダーAI・5段階警戒レベル・フリーズ回避 統合版 ---

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
    log: function(m, category = 'system') {
        const c = document.getElementById('log-console');
        const e = document.createElement('div'); e.className = 'log-entry';
        e.dataset.category = category;
        let prefix = category === 'combat' ? '⚔️' : (category === 'diplomacy' ? '🤝' : (category === 'ai' ? '💡' : '📢'));
        e.innerHTML = `<span class="log-month">[${GameState.year}/${GameState.month}/${GameState.day}]</span> ${prefix} ${m}`;
        c.prepend(e);
        if (currentLogFilter !== 'all' && currentLogFilter !== category) e.classList.add('hidden');
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
        // 🌟 非カレンダー型AI: 毎日各城が5%の確率で戦略を自問自答
        Object.values(GameState.castles).forEach(c => {
            if (c.faction !== 'independent' && c.faction !== GameState.playerFaction) {
                if (Math.random() < 0.05) this.runAIForCastle(c);
            }
        });

        const pIdx = GameState.priceIndex;
        const isWinter = (GameState.month === 12 || GameState.month <= 2);

        // 🌟 フリーズ回避: 同盟した城を攻めている部隊を待機状態へ
        GameState.armies.forEach(a => {
            if (a.troops <= 0) return;
            if (a.targetNodeId && a.task === 'attack') {
                let targetCastle = GameState.castles[a.targetNodeId];
                if (targetCastle && window.areAllies(a.faction, targetCastle.faction)) {
                    a.task = 'hold'; a.targetNodeId = null; a.pathQueue = [];
                    if (a.faction === GameState.playerFaction) this.log(`${targetCastle.name}と和睦したため攻撃を中止。`, 'diplomacy');
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
            let isAlly = (node && node.type !== "5") ? window.areAllies(a.faction, GameState.castles[node.id]?.faction) : false;
            let rate = (a.task === 'attack' && !a.pathQueue.length) ? 5.0 : (isAlly ? 3.0 : 4.0);
            a.food -= Math.floor((a.troops / 100) * rate * pIdx);
            if (a.food <= 0) { a.food = 0; a.troops = Math.max(0, a.troops - Math.max(1, Math.floor(a.troops * 0.05))); }

            // 自動撤退
            if (a.task !== 'retreat' && a.troops > 0) {
                let req = Math.floor((a.troops / 100) * 3.0 * pIdx * 15);
                if (a.food < req) { a.task = 'retreat'; a.targetNodeId = null; a.pathQueue = []; }
            }
        });

        // 移動
        GameState.armies.forEach(a => {
            if (a.troops <= 0) return;
            let targetLat, targetLng, spd = 1.0;
            if (a.pathQueue.length > 0) {
                let i = window.rawNodes.find(x => x.id === a.pathQueue[0].nodeId);
                targetLat = i.lat; targetLng = i.lng; spd = a.pathQueue[0].speedMod;
            } else if (a.targetLatLng) {
                targetLat = a.targetLatLng.lat; targetLng = a.targetLatLng.lng;
            } else return;

            let move = (a.task==='transport'?3:6) * spd * (isWinter?0.5:1.0) * Math.max(0.5, 1.2 - (a.troops/20000));
            let d = map.distance(L.latLng(a.pos.lat, a.pos.lng), L.latLng(targetLat, targetLng)) / 1000;
            if (move >= d) {
                a.pos = { lat: targetLat, lng: targetLng };
                if (a.pathQueue.length > 0) a.pathQueue.shift();
                else if (a.targetLatLng) a.targetLatLng = null;
            } else {
                let r = move / d; a.pos.lat += (targetLat - a.pos.lat) * r; a.pos.lng += (targetLng - a.pos.lng) * r;
            }
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
            if (!node || node.type === "5") return;
            const castle = GameState.castles[node.id]; if(!castle) return;

            if (map.distance(L.latLng(army.pos), L.latLng(node.lat, node.lng)) < 200) {
                if (castle.faction === army.faction) {
                    if (army.task === 'transport' || !army.pathQueue.length) {
                        castle.troops += army.troops; castle.gold += army.gold; castle.food += army.food; army.troops = 0;
                    }
                } else if (!window.areAllies(army.faction, castle.faction)) {
                    if (castle.siegeHP > 0) {
                        castle.siegeHP -= Math.floor(army.troops * 0.05); army.troops -= Math.floor(castle.troops * 0.02);
                    } else if (army.troops > castle.troops * 1.2) {
                        castle.faction = army.faction; castle.troops = Math.floor(army.troops * 0.5); army.troops = 0;
                        castle.siegeHP = castle.maxSiegeHP * 0.2;
                        this.log(`${castle.name} が ${FactionMaster[castle.faction].name} に落とされました！`, 'combat');
                    }
                }
            }
        });
    },

    // 🌟 城単位のAI思考（日次）
    runAIForCastle: function(c) {
        if (c.troops < 1000 || c.food < c.currentKokudaka * 5) return;
        const pIdx = GameState.priceIndex;
        const cN = window.rawNodes.find(n => n.id === c.id);
        
        let candidates = Object.values(GameState.castles)
            .filter(t => t.faction !== c.faction && !window.areAllies(c.faction, t.faction))
            .map(t => {
                let tN = window.rawNodes.find(n => n.id === t.id);
                return { castle: t, dist: map.distance(L.latLng(cN.lat, cN.lng), L.latLng(tN.lat, tN.lng)) };
            })
            .sort((a, b) => a.dist - b.dist).slice(0, 3);

        candidates.forEach(cand => {
            let route = findShortestPath(c.id, cand.castle.id);
            if (route) {
                let deploy = Math.floor(c.troops * 0.6);
                let estFood = Math.floor((deploy / 100) * 4.0 * pIdx * 60);
                if (c.food > estFood) {
                    let a = window.deployArmy(c.id, deploy, true, 'attack', 0, estFood);
                    if (a) { a.pathQueue = route; a.targetNodeId = cand.castle.id; }
                }
            }
        });
    },

    finalizeMonth: function() {
        GameState.month++; if (GameState.month > 12) { GameState.month = 1; GameState.year++; }
        const pIdx = GameState.priceIndex;
        Object.values(GameState.castles).forEach(c => {
            if (c.faction === "independent") return;
            c.gold += Math.floor(c.commerce * 0.2 * pIdx);
            if(GameState.month === 9) c.food += Math.floor(c.currentKokudaka * 1.0 * pIdx);
            c.food = Math.min(c.food, c.currentKokudaka * 15);
            let max = getMaxTroops(c); if(c.troops < max) c.troops += Math.floor(max * 0.05);
        });

        // 外交摩擦と同盟による停止
        Object.values(GameState.castles).forEach(c => {
            if (c.faction === 'independent') return;
            window.graph[c.id].forEach(e => {
                let neighbor = GameState.castles[e.to];
                if (neighbor && neighbor.faction !== 'independent' && neighbor.faction !== c.faction) {
                    if (!window.areAllies(c.faction, neighbor.faction)) window.addHate(c.faction, neighbor.faction, 2);
                }
            });
        });

        // 🌟 5段階警戒レベル
        let factionKoku = {}, totalKoku = 0;
        const factions = Object.keys(FactionMaster).filter(f => f !== 'independent');
        Object.values(GameState.castles).forEach(c => { if(c.faction!=='independent'){ factionKoku[c.faction] = (factionKoku[c.faction]||0)+c.currentKokudaka; totalKoku+=c.currentKokudaka; }});
        
        factions.forEach(f => {
            let share = factionKoku[f] / (totalKoku || 1);
            let level = share > 0.35 ? 5 : (share > 0.25 ? 4 : (share > 0.20 ? 3 : (share > 0.15 ? 2 : (share > 0.10 ? 1 : 0))));
            if (level >= 3) {
                factions.forEach(other => {
                    if (other !== f) {
                        window.addHate(other, f, level * 10);
                        if (level >= 4) window.addFriendship(other, factions.find(x=>x!==f&&x!==other), 20);
                    }
                });
                if (GameState.month === 1) this.log(`諸大名が ${FactionMaster[f].name} への警戒を強めています (Lv${level})`, 'diplomacy');
            }
        });

        // 呉越同舟
        for(let i=0; i<factions.length; i++) {
            for(let j=i+1; j<factions.length; j++) {
                let f1 = factions[i], f2 = factions[j];
                factions.forEach(enemy => {
                    if (enemy!==f1 && enemy!==f2 && (GameState.hateMatrix[f1]?.[enemy]||0)>200 && (GameState.hateMatrix[f2]?.[enemy]||0)>200) {
                        window.addFriendship(f1, f2, 10); window.addFriendship(f2, f1, 10);
                    }
                });
            }
        }

        // 外交減衰と更新
        for (let f1 in GameState.hateMatrix) for (let f2 in GameState.hateMatrix[f1]) GameState.hateMatrix[f1][f2] = Math.max(0, GameState.hateMatrix[f1][f2] - 10);
        for (let f1 in GameState.friendshipMatrix) for (let f2 in GameState.friendshipMatrix[f1]) GameState.friendshipMatrix[f1][f2] = Math.max(0, GameState.friendshipMatrix[f1][f2] - 5);
        
        GameState.alliances = {};
        factions.forEach(f1 => factions.forEach(f2 => {
            if (f1 === f2) return;
            let score = (window.getDiplomacyScore(f1, f2) + window.getDiplomacyScore(f2, f1)) / 2;
            if (score >= 600) GameState.alliances[`${f1}-${f2}`] = 3;
            else if (score >= 300) GameState.alliances[`${f1}-${f2}`] = 2;
            else if (score >= 150) GameState.alliances[`${f1}-${f2}`] = 1;
        }));

        updateUI(); drawMap();
    }
};
