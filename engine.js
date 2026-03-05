// --- engine.js: ゲームの状態管理と、ターン進行・AI・戦闘ロジック ---

const GameState = {
    isLoaded: false, hasStarted: false, isPaused: true,
    year: 1560, month: 1, day: 1, gold: 3000, castles: {}, armies: [], armyIdCounter: 1,
    playerFaction: null 
};

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

        const dailyMoveBase = 5; 

        GameState.armies.forEach(army => {
            if (army.troops <= 0 || army.pathQueue.length === 0) return;

            let nextStep = army.pathQueue[0];
            let targetLat = nextStep.isVirtual ? nextStep.lat : window.rawNodes.find(n => n.id === nextStep.nodeId).lat;
            let targetLng = nextStep.isVirtual ? nextStep.lng : window.rawNodes.find(n => n.id === nextStep.nodeId).lng;

            let distToNext = map.distance(L.latLng(army.pos.lat, army.pos.lng), L.latLng(targetLat, targetLng)) / 1000;
            if(distToNext < 0.1) distToNext = 0;

            let dailyMove = dailyMoveBase * nextStep.speedMod;

            if (dailyMove >= distToNext) {
                army.pos = { lat: targetLat, lng: targetLng };
                army.pathQueue.shift();
                if (nextStep.isVirtual || (window.rawNodes.find(n => n.id === nextStep.nodeId).type !== "5" && window.rawNodes.find(n => n.id === nextStep.nodeId).type !== "0")) {
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

        if (typeof window.updateArmyMarkers === 'function') window.updateArmyMarkers();
        updateUI();

        GameState.day++;
        if (GameState.day > 30) {
            GameState.day = 1;
            this.finalizeMonth();
        }
    },

    resolveBattlesInTick: function() {
        GameState.armies.forEach(army => {
            if (army.troops <= 0) return;
            const node = getClosestNode(army.pos);
            if (!node || node.type === "5" || node.type === "0") return;
            
            const dist = map.distance(L.latLng(army.pos.lat, army.pos.lng), L.latLng(node.lat, node.lng));
            if (dist < 200) { 
                const castle = GameState.castles[node.id];
                if (castle.faction === army.faction) {
                    if(army.pathQueue.length === 0) {
                        // 【修正】徴兵上限に関係なく、城に入る部隊の兵力をそのまま足す（上限撤廃）
                        castle.troops += army.troops;
                        army.troops = 0; 
                    }
                } else {
                    const attTraits = getFactionTraits(army.faction);
                    const defTraits = getFactionTraits(castle.faction);

                    const attack = army.troops * (0.8 + Math.random() * 0.4) * attTraits.combat_bonus;
                    const defense = castle.troops * (0.8 + (castle.defense / 100) * 0.5 + Math.random() * 0.4) * defTraits.defense_bonus; 
                    
                    if (attack > defense) {
                        castle.faction = army.faction; 
                        army.troops = Math.floor(army.troops * 0.8); castle.troops = 0;
                        this.log(`<span class="log-combat">🎊 ${FactionMaster[army.faction].name}が ${castle.name} を落としました！</span>`);
                        
                        const isPlayerInvolved = GameState.playerFaction !== null && (GameState.castles[node.id].faction === GameState.playerFaction || army.faction === GameState.playerFaction);
                        if(isPlayerInvolved) {
                            if(!GameState.isPaused) this.toggleTime();
                        }
                    } else {
                        army.troops = Math.floor(army.troops * 0.5); castle.troops = Math.floor(castle.troops * 0.7);
                        this.log(`<span class="log-combat">💀 ${FactionMaster[army.faction].name}の部隊が ${castle.name} の攻城に失敗。</span>`);
                    }
                    army.pathQueue = []; 
                }
            }
        });

        for(let i=0; i<GameState.armies.length; i++) {
            for(let j=i+1; j<GameState.armies.length; j++) {
                let a1 = GameState.armies[i]; let a2 = GameState.armies[j];
                if (a1.troops > 0 && a2.troops > 0 && a1.faction !== a2.faction) {
                    if (map.distance(L.latLng(a1.pos.lat, a1.pos.lng), L.latLng(a2.pos.lat, a2.pos.lng)) < 1000) { 
                        this.log(`<span class="log-combat">⚔️ 野戦！ ${FactionMaster[a1.faction].name}と${FactionMaster[a2.faction].name}が激突！</span>`);
                        const t1 = getFactionTraits(a1.faction);
                        const t2 = getFactionTraits(a2.faction);
                        let att = a1.troops * (0.8 + Math.random() * 0.4) * t1.combat_bonus;
                        let def = a2.troops * (0.8 + Math.random() * 0.4) * t2.combat_bonus;
                        
                        if (att > def) { a2.troops = Math.floor(a2.troops * 0.3); a1.troops = Math.floor(a1.troops * 0.8); } 
                        else { a1.troops = Math.floor(a1.troops * 0.3); a2.troops = Math.floor(a2.troops * 0.8); }
                        a1.pathQueue = []; a2.pathQueue = [];
                        
                        const isPlayerInvolvedWild = GameState.playerFaction !== null && (a1.faction === GameState.playerFaction || a2.faction === GameState.playerFaction);
                        if(isPlayerInvolvedWild) {
                            if(!GameState.isPaused) this.toggleTime();
                        }
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
            else if (army.targetNodeId && GameState.castles[army.targetNodeId]?.faction === army.faction) needsNewTarget = true;

            if (needsNewTarget) {
                let startNode = getClosestNode(army.pos);
                let candidates = Object.values(GameState.castles)
                    .filter(t => t.faction !== army.faction && army.troops > t.troops * 1.1)
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
                    const priorityBonus = (GameState.playerFaction !== null && targetCastle.faction === GameState.playerFaction) ? 3000 : (targetCastle.faction === "independent" ? 1000 : 0); 
                    const score = (10000 / (totalCost + 1)) - targetCastle.troops + priorityBonus;
                    if (score > bestScore) { bestScore = score; bestTarget = { id: targetCastle.id, route: route }; }
                });

                if (bestTarget) {
                    army.pathQueue = bestTarget.route; army.targetNodeId = bestTarget.id;
                    this.log(`<span class="log-ai">【進軍】${FactionMaster[army.faction].name}の部隊が ${GameState.castles[bestTarget.id].name} へ目標設定。</span>`);
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
                .filter(t => t.faction !== castle.faction && deployableTroops > t.troops * 1.1)
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
                const priorityBonus = (GameState.playerFaction !== null && targetCastle.faction === GameState.playerFaction) ? 3000 : (targetCastle.faction === "independent" ? 1000 : 0); 
                const score = (10000 / (totalCost + 1)) - targetCastle.troops + priorityBonus;
                
                if (score > bestScore) { bestScore = score; bestTarget = { id: targetCastle.id, route: route }; }
            });

            if (bestTarget) {
                const army = window.deployArmy(castle.id, deployableTroops, true);
                if (army) {
                    army.pathQueue = bestTarget.route; army.targetNodeId = bestTarget.id;
                    const tName = GameState.castles[bestTarget.id].name;
                    this.log(`<span class="log-ai">【侵攻】${FactionMaster[castle.faction].name}が ${deployableTroops} の兵で ${tName} へ出撃！</span>`);
                }
            }
        });
    },

    finalizeMonth: function() {
        GameState.month++; if (GameState.month > 12) { GameState.month = 1; GameState.year++; }
        
        let monthlyIncome = 0;
        Object.values(GameState.castles).forEach(castle => {
            const maxTroops = getMaxTroops(castle);
            const traits = getFactionTraits(castle.faction);

            if (GameState.playerFaction !== null && castle.faction === GameState.playerFaction) {
                // 【修正】回復も、上限を超えていない場合のみ回復するように
                if (castle.troops < maxTroops) castle.troops = Math.min(maxTroops, castle.troops + Math.floor(maxTroops * 0.05)); 
                monthlyIncome += Math.floor(castle.currentKokudaka * 0.01) + Math.floor(castle.commerce * 0.2);
            } else if (castle.faction !== "independent") {
                const recoveryBase = Math.floor(maxTroops * 0.05 + 10);
                if (castle.troops < maxTroops) {
                    castle.troops = Math.min(maxTroops, castle.troops + Math.floor(recoveryBase * traits.recruit_bonus)); 
                }
            }
        });
        GameState.gold += monthlyIncome;
        
        updateUI(); drawMap();
    }
};
