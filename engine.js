// --- engine.js: 戦略・外交・補給・攻城戦ロジック統合版 ---

const GameState = {
    isLoaded: false, hasStarted: false, isPaused: true,
    year: 1560, month: 1, day: 1, gold: 3000, castles: {}, armies: [], armyIdCounter: 1,
    playerFaction: null, alliances: new Set(), coalitionTarget: null
};

// 外交判定用ヘルパー関数
function areAllies(f1, f2) {
    if (f1 === f2) return true;
    return GameState.alliances.has(`${f1}-${f2}`) || GameState.alliances.has(`${f2}-${f1}`);
}

const gameEngine = {
    log: function(msg) {
        const consoleEl = document.getElementById('log-console');
        const entry = document.createElement('div');
        entry.className = 'log-entry';
        entry.innerHTML = `<span class="log-month">[${GameState.year}年${GameState.month}月${GameState.day}日]</span> ${msg}`;
        consoleEl.prepend(entry);
    },

    toggleTime: function() {
        if (!GameState.hasStarted) return;
        GameState.isPaused = !GameState.isPaused;
        const btn = document.getElementById('btnToggleTime');
        if (GameState.isPaused) {
            btn.innerText = '▶ 時間を進める'; btn.classList.remove('active');
        } else {
            btn.innerText = '⏸ 一時停止'; btn.classList.add('active');
            this.gameLoop();
        }
    },

    gameLoop: function() {
        if (GameState.isPaused || !GameState.hasStarted) return;
        this.tickDay();
        const delay = parseInt(document.getElementById('speedSlider').value);
        setTimeout(() => this.gameLoop(), delay);
    },

    tickDay: function() {
        if (GameState.day === 1) this.runAI();

        // 季節による移動速度の変化（冬は雪で遅くなる）
        let isWinter = (GameState.month === 12 || GameState.month <= 2);
        const dailyMoveBase = isWinter ? 3 : 6; 

        GameState.armies.forEach(army => {
            if (army.troops <= 0 || army.pathQueue.length === 0) return;

            // 補給線の概念：敵領土にいると毎日兵糧不足で兵が減る（1日1%減）
            const closestNode = getClosestNode(army.pos);
            const territory = GameState.castles[closestNode.id];
            if (territory && territory.faction !== army.faction && territory.faction !== "independent" && !areAllies(army.faction, territory.faction)) {
                army.troops = Math.max(0, Math.floor(army.troops * 0.99));
            }

            let nextStep = army.pathQueue[0];
            let targetLat = window.rawNodes.find(n => n.id === nextStep.nodeId).lat;
            let targetLng = window.rawNodes.find(n => n.id === nextStep.nodeId).lng;

            let distToNext = map.distance(L.latLng(army.pos.lat, army.pos.lng), L.latLng(targetLat, targetLng)) / 1000;
            if(distToNext < 0.1) distToNext = 0;

            let dailyMove = dailyMoveBase * nextStep.speedMod;

            if (dailyMove >= distToNext) {
                army.pos = { lat: targetLat, lng: targetLng };
                army.pathQueue.shift();
                if (window.rawNodes.find(n => n.id === nextStep.nodeId).type !== "5" && window.rawNodes.find(n => n.id === nextStep.nodeId).type !== "0") {
                    army.pathQueue = []; 
                }
            } else {
                let ratio = distToNext === 0 ? 0 : dailyMove / distToNext;
                army.pos.lat += (targetLat - army.pos.lat) * ratio;
                army.pos.lng += (targetLng - army.pos.lng) * ratio;
            }
        });

        this.resolveBattlesInTick();

        GameState.armies = GameState.armies.filter(a => a.troops > 0);

        if (typeof window.updateDynamicVisuals === 'function') window.updateDynamicVisuals();
        updateUI();

        GameState.day++;
        if (GameState.day > 30) {
            GameState.day = 1;
            this.finalizeMonth();
        }
    },

    resolveBattlesInTick: function() {
        // 攻城戦の処理（耐久度システム）
        GameState.armies.forEach(army => {
            if (army.troops <= 0) return;
            const node = getClosestNode(army.pos);
            if (!node || node.type === "5" || node.type === "0") return;
            
            const dist = map.distance(L.latLng(army.pos.lat, army.pos.lng), L.latLng(node.lat, node.lng));
            if (dist < 200) { 
                const castle = GameState.castles[node.id];
                if (castle.faction === army.faction) {
                    if(army.pathQueue.length === 0) {
                        castle.troops += army.troops; army.troops = 0; 
                    }
                } else if (!areAllies(army.faction, castle.faction)) {
                    // 同盟国でなければ攻城戦開始
                    army.pathQueue = []; // 足止め
                    
                    const attTraits = getFactionTraits(army.faction);
                    const defTraits = getFactionTraits(castle.faction);

                    // 1日あたりの攻城ダメージ計算
                    const damage = Math.floor(army.troops * 0.05 * attTraits.combat_bonus * (0.8 + Math.random() * 0.4));
                    castle.siegeHP -= Math.max(1, damage);

                    // 攻城側と守備兵も少しずつ減る（消耗戦）
                    army.troops = Math.max(0, Math.floor(army.troops * 0.995));
                    castle.troops = Math.max(0, Math.floor(castle.troops * 0.99));

                    if (castle.siegeHP <= 0) {
                        castle.faction = army.faction; 
                        castle._flash = true; // 描画時にフラッシュ演出
                        if(typeof window.showFloatingText === 'function') {
                            const nDef = window.rawNodes.find(n => n.id === castle.id);
                            window.showFloatingText(nDef.lat, nDef.lng, "🎊 落城", FactionMaster[army.faction].color);
                        }
                        army.troops = Math.floor(army.troops * 0.8);
                        castle.troops = 0;
                        castle.siegeHP = castle.maxSiegeHP; // 耐久度全快で引き継ぐ
                        
                        this.log(`<span class="log-combat">🎊 <b>${FactionMaster[army.faction].name}</b>が ${castle.name} を陥落させました！</span>`);
                        drawMap(); // 色やフラッシュを即反映

                        const isPlayerInvolved = GameState.playerFaction !== null && (GameState.castles[node.id].faction === GameState.playerFaction || army.faction === GameState.playerFaction);
                        if(isPlayerInvolved && !GameState.isPaused) this.toggleTime();
                    }
                }
            }
        });

        // 野戦の処理（変更なし）
        for(let i=0; i<GameState.armies.length; i++) {
            for(let j=i+1; j<GameState.armies.length; j++) {
                let a1 = GameState.armies[i]; let a2 = GameState.armies[j];
                if (a1.troops > 0 && a2.troops > 0 && a1.faction !== a2.faction && !areAllies(a1.faction, a2.faction)) {
                    if (map.distance(L.latLng(a1.pos.lat, a1.pos.lng), L.latLng(a2.pos.lat, a2.pos.lng)) < 1000) { 
                        const t1 = getFactionTraits(a1.faction); const t2 = getFactionTraits(a2.faction);
                        let att = a1.troops * (0.8 + Math.random() * 0.4) * t1.combat_bonus;
                        let def = a2.troops * (0.8 + Math.random() * 0.4) * t2.combat_bonus;
                        
                        if (att > def) { a2.troops = Math.floor(a2.troops * 0.3); a1.troops = Math.floor(a1.troops * 0.8); } 
                        else { a1.troops = Math.floor(a1.troops * 0.3); a2.troops = Math.floor(a2.troops * 0.8); }
                        a1.pathQueue = []; a2.pathQueue = [];
                        
                        if(typeof window.showFloatingText === 'function') {
                            window.showFloatingText(a1.pos.lat, a1.pos.lng, "⚔️ 激突", "#e74c3c");
                        }
                        
                        const isPlayerInvolvedWild = GameState.playerFaction !== null && (a1.faction === GameState.playerFaction || a2.faction === GameState.playerFaction);
                        if(isPlayerInvolvedWild && !GameState.isPaused) this.toggleTime();
                    }
                }
            }
        }
    },

    runAI: function() {
        GameState.armies.forEach(army => {
            if (GameState.playerFaction !== null && army.faction === GameState.playerFaction) return;
            if (army.faction === "independent") return;
            
            let needsNewTarget = false;
            if (army.pathQueue.length === 0) needsNewTarget = true;
            else if (army.targetNodeId && (GameState.castles[army.targetNodeId]?.faction === army.faction || areAllies(army.faction, GameState.castles[army.targetNodeId]?.faction))) needsNewTarget = true;

            if (needsNewTarget) {
                let startNode = getClosestNode(army.pos);
                let candidates = Object.values(GameState.castles)
                    .filter(t => t.faction !== army.faction && !areAllies(army.faction, t.faction) && army.troops > t.troops * 0.8)
                    .map(t => {
                        const tNode = window.rawNodes.find(n => n.id === t.id);
                        const dist = map.distance(L.latLng(startNode.lat, startNode.lng), L.latLng(tNode.lat, tNode.lng)) / 1000;
                        return { castle: t, dist: dist };
                    })
                    .sort((a, b) => a.dist - b.dist).slice(0, 5); 

                let bestTarget = null; let bestScore = -Infinity;

                candidates.forEach(cand => {
                    const targetCastle = cand.castle;
                    const route = findShortestPath(startNode.id, targetCastle.id);
                    if (!route) return;

                    const totalCost = route.reduce((sum, r) => sum + (r.dist / r.speedMod), 0);
                    // 包囲網ターゲットへの攻撃は優先度大
                    const priorityBonus = (targetCastle.faction === GameState.coalitionTarget) ? 5000 : (targetCastle.faction === "independent" ? 1000 : 0); 
                    const score = (10000 / (totalCost + 1)) - targetCastle.troops + priorityBonus;
                    if (score > bestScore) { bestScore = score; bestTarget = { id: targetCastle.id, route: route }; }
                });

                if (bestTarget) {
                    army.pathQueue = bestTarget.route; army.targetNodeId = bestTarget.id;
                } else {
                    let closestAlly = null; let minCost = Infinity; let bestRoute = null;
                    Object.values(GameState.castles).forEach(allyCastle => {
                        if(allyCastle.faction !== army.faction) return;
                        const route = findShortestPath(startNode.id, allyCastle.id);
                        if(route) {
                            const cost = route.reduce((sum, r) => sum + (r.dist / r.speedMod), 0);
                            if(cost < minCost) { minCost = cost; closestAlly = allyCastle; bestRoute = route; }
                        }
                    });
                    if(closestAlly && bestRoute) { army.pathQueue = bestRoute; army.targetNodeId = closestAlly.id; }
                }
            }
        });

        Object.values(GameState.castles).forEach(castle => {
            if (GameState.playerFaction !== null && castle.faction === GameState.playerFaction) return;
            if (castle.faction === "independent") return;
            const maxT = getMaxTroops(castle);
            const traits = getFactionTraits(castle.faction); 
            const threshold = maxT * traits.wait_threshold;
            const sortieProb = 0.3 * traits.aggression;

            if (castle.troops < 150 || castle.troops < threshold || Math.random() > sortieProb) return; 

            const deployableTroops = Math.floor(castle.troops * 0.4);
            const cNode = window.rawNodes.find(n => n.id === castle.id);
            
            let candidates = Object.values(GameState.castles)
                .filter(t => t.faction !== castle.faction && !areAllies(castle.faction, t.faction) && deployableTroops > t.troops * 0.8)
                .map(t => {
                    const tNode = window.rawNodes.find(n => n.id === t.id);
                    const dist = map.distance(L.latLng(cNode.lat, cNode.lng), L.latLng(tNode.lat, tNode.lng)) / 1000;
                    return { castle: t, dist: dist };
                })
                .sort((a, b) => a.dist - b.dist).slice(0, 5); 

            let bestTarget = null; let bestScore = -Infinity;

            candidates.forEach(cand => {
                const targetCastle = cand.castle;
                const route = findShortestPath(castle.id, targetCastle.id);
                if (!route) return;

                const totalCost = route.reduce((sum, r) => sum + (r.dist / r.speedMod), 0);
                const priorityBonus = (targetCastle.faction === GameState.coalitionTarget) ? 5000 : 0; 
                const score = (10000 / (totalCost + 1)) - targetCastle.troops + priorityBonus;
                
                if (score > bestScore) { bestScore = score; bestTarget = { id: targetCastle.id, route: route }; }
            });

            if (bestTarget) {
                const army = window.deployArmy(castle.id, deployableTroops, true);
                if (army) {
                    army.pathQueue = bestTarget.route; army.targetNodeId = bestTarget.id;
                    const tName = GameState.castles[bestTarget.id].name;
                    this.log(`<span class="log-ai">【出陣】${FactionMaster[castle.faction].name}が ${tName} へ侵攻開始！</span>`);
                }
            }
        });
    },

    finalizeMonth: function() {
        GameState.month++; if (GameState.month > 12) { GameState.month = 1; GameState.year++; }
        
        // --- 季節と経済の処理 ---
        const isAutumnHarvest = (GameState.month === 9); // 9月は収穫の秋！
        let monthlyIncome = 0;
        
        Object.values(GameState.castles).forEach(castle => {
            const maxTroops = getMaxTroops(castle);
            const traits = getFactionTraits(castle.faction);

            if (GameState.playerFaction !== null && castle.faction === GameState.playerFaction) {
                if (castle.troops < maxTroops) castle.troops = Math.min(maxTroops, castle.troops + Math.floor(maxTroops * 0.05)); 
                
                // 資金収入：通常月は商業のみ、9月は石高の特大ボーナス
                if(isAutumnHarvest) {
                    monthlyIncome += Math.floor(castle.currentKokudaka * 1.5) + Math.floor(castle.commerce * 0.2);
                } else {
                    monthlyIncome += Math.floor(castle.commerce * 0.5);
                }
            } else if (castle.faction !== "independent") {
                const recoveryBase = Math.floor(maxTroops * 0.05 + 10);
                if (castle.troops < maxTroops) {
                    castle.troops = Math.min(maxTroops, castle.troops + Math.floor(recoveryBase * traits.recruit_bonus)); 
                }
            }
            // 城の耐久度も毎月少し自動回復
            if (castle.siegeHP < castle.maxSiegeHP) {
                castle.siegeHP = Math.min(castle.maxSiegeHP, castle.siegeHP + (castle.defense * 2));
            }
        });
        
        if (monthlyIncome > 0 && GameState.playerFaction !== null) {
            GameState.gold += monthlyIncome;
            if(isAutumnHarvest) this.log(`<span style="color:#d35400;">🌾 秋の収穫！年貢として金 ${monthlyIncome} が入りました。</span>`);
        }

        // --- 外交：大包囲網ロジック ---
        const totalCastles = Object.keys(GameState.castles).length;
        const factionCounts = {};
        Object.values(GameState.castles).forEach(c => {
            if(c.faction !== 'independent') {
                factionCounts[c.faction] = (factionCounts[c.faction] || 0) + 1;
            }
        });

        let biggestFaction = null; let maxOwned = 0;
        Object.keys(factionCounts).forEach(f => {
            if(factionCounts[f] > maxOwned) { maxOwned = factionCounts[f]; biggestFaction = f; }
        });

        // どこかの勢力が全体の15%以上の城を持ったら包囲網結成
        GameState.alliances.clear();
        GameState.coalitionTarget = null;
        
        if (maxOwned >= Math.max(3, totalCastles * 0.15)) {
            GameState.coalitionTarget = biggestFaction;
            if(GameState.month === 1) this.log(`<span style="color:#c0392b; font-weight:bold;">⚠️ 各国の諸将が結託し【反 ${FactionMaster[biggestFaction].name} 包囲網】が形成されました！</span>`);
            
            // 包囲網ターゲット以外のAI同士はすべて同盟を結ぶ
            const others = Object.keys(factionCounts).filter(f => f !== biggestFaction);
            for(let i=0; i<others.length; i++) {
                for(let j=i+1; j<others.length; j++) {
                    GameState.alliances.add(`${others[i]}-${others[j]}`);
                }
            }
        }

        updateUI(); drawMap();
    }
};
