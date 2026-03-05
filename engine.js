// --- engine.js: 兵站ロジスティクス・略奪・動的追尾 完全版 ---

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
    let f = (GameState.friendshipMatrix[f1]?.[f2] || 0);
    let h = (GameState.hateMatrix[f1]?.[f2] || 0);
    return f - h;
};

function addHate(fromFaction, toFaction, amount) {
    if (fromFaction === toFaction || fromFaction === 'independent' || toFaction === 'independent') return;
    if (!GameState.hateMatrix[fromFaction]) GameState.hateMatrix[fromFaction] = {};
    GameState.hateMatrix[fromFaction][toFaction] = (GameState.hateMatrix[fromFaction][toFaction] || 0) + amount;
}
function addFriendship(fromFaction, toFaction, amount) {
    if (fromFaction === toFaction || fromFaction === 'independent' || toFaction === 'independent') return;
    if (!GameState.friendshipMatrix[fromFaction]) GameState.friendshipMatrix[fromFaction] = {};
    GameState.friendshipMatrix[fromFaction][toFaction] = (GameState.friendshipMatrix[fromFaction][toFaction] || 0) + amount;
}
function areAllies(f1, f2) { return window.getAllianceLevel(f1, f2) > 0; }

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

        let isWinter = (GameState.month === 12 || GameState.month <= 2);
        const dailyMoveBase = isWinter ? 3 : 6; 
        const pIdx = GameState.priceIndex;

        // 🌟 1. 城の駐屯兵の兵糧消費（城ベース）
        Object.values(GameState.castles).forEach(c => {
            if(c.faction === 'independent') return;
            let dailyCost = Math.floor((c.troops / 100) * 1 * pIdx);
            c.food -= dailyCost;
            if (c.food < 0) {
                c.food = 0;
                c.troops = Math.max(0, Math.floor(c.troops * 0.95)); // 餓死・脱走
            }
        });

        // 🌟 2. 行軍中の部隊の兵糧消費（部隊ベース）
        GameState.armies.forEach(a => {
            let dailyCost = Math.floor((a.troops / 100) * 3 * pIdx);
            a.food -= dailyCost;
            if (a.food < 0) {
                a.food = 0;
                let loss = Math.max(1, Math.floor(a.troops * 0.05));
                a.troops = Math.max(0, a.troops - loss);
                if (GameState.day % 5 === 0 && typeof window.showFloatingText === 'function') {
                    window.showFloatingText(a.pos.lat, a.pos.lng, "餓死", "#e74c3c");
                }
            }
        });

        // 3. 工期タスクの進行
        for (let i = GameState.tasks.length - 1; i >= 0; i--) {
            let t = GameState.tasks[i];
            t.daysLeft--;
            if (t.daysLeft <= 0) {
                const c = GameState.castles[t.castleId];
                if (c && c.faction === t.faction) { 
                    if (t.type === 'agriculture') {
                        c.currentKokudaka += 2000; c.loyalty = Math.min(100, c.loyalty + 5);
                        if(t.faction === GameState.playerFaction) this.log(`【竣工】${c.name} の開墾が完了しました。`);
                    } else if (t.type === 'commerce') {
                        c.commerce += 50; c.loyalty = Math.min(100, c.loyalty + 5);
                        if(t.faction === GameState.playerFaction) this.log(`【竣工】${c.name} の市の保護が完了しました。`);
                    } else if (t.type === 'repair') {
                        c.siegeHP = c.maxSiegeHP;
                        if(t.faction === GameState.playerFaction) this.log(`【竣工】${c.name} の修繕が完了しました。`);
                    } else if (t.type === 'defense') {
                        c.defense += 20;
                        let hpMult = (c.type==="1")? 15 : ((c.type==="3")? 3 : ((c.type==="4")? 5 : 10));
                        c.maxSiegeHP = c.defense * hpMult; c.siegeHP = c.maxSiegeHP;
                        if(t.faction === GameState.playerFaction) this.log(`【竣工】${c.name} の本格改修が完了しました。`);
                    }
                }
                GameState.tasks.splice(i, 1);
            }
        }

        // 🌟 4. 移動・動的追跡ロジック
        GameState.armies.forEach(army => {
            if (army.troops <= 0) return;

            // 動的ターゲット（軍勢）を追いかける場合、3日おきにルート再検索
            if (army.targetArmyId) {
                let targetArmy = GameState.armies.find(a => a.id === army.targetArmyId);
                if (!targetArmy || targetArmy.troops <= 0) {
                    army.targetArmyId = null; army.pathQueue = []; army.task = 'hold'; // 見失った
                } else if (GameState.day % 3 === 0) {
                    let closestMyNode = getClosestNode(army.pos);
                    let closestTargetNode = getClosestNode(targetArmy.pos);
                    let route = window.findShortestPath(closestMyNode.id, closestTargetNode.id);
                    if (route) army.pathQueue = route;
                }
            }

            let nextStep = army.pathQueue[0];
            let targetLat, targetLng, speedMod = 1.0;

            if (nextStep) {
                let nInfo = window.rawNodes.find(n => n.id === nextStep.nodeId);
                targetLat = nInfo.lat; targetLng = nInfo.lng;
                speedMod = nextStep.speedMod;
            } else if (army.targetLatLng) {
                targetLat = army.targetLatLng.lat; targetLng = army.targetLatLng.lng;
            } else if (army.targetArmyId) {
                let ta = GameState.armies.find(a => a.id === army.targetArmyId);
                targetLat = ta.pos.lat; targetLng = ta.pos.lng;
            } else {
                return; // 完全に停止
            }

            let distToNext = map.distance(L.latLng(army.pos.lat, army.pos.lng), L.latLng(targetLat, targetLng)) / 1000;
            if(distToNext < 0.1) distToNext = 0;

            // 🌟 輸送隊は速度半分
            let actualSpeedBase = army.task === 'transport' ? (dailyMoveBase * 0.5) : dailyMoveBase;
            let dailyMove = actualSpeedBase * speedMod;

            if (dailyMove >= distToNext) {
                army.pos = { lat: targetLat, lng: targetLng };
                if (army.pathQueue.length > 0) {
                    army.pathQueue.shift();
                } else if (army.targetLatLng) {
                    army.targetLatLng = null; army.task = 'hold';
                }
            } else {
                let ratio = distToNext === 0 ? 0 : dailyMove / distToNext;
                army.pos.lat += (targetLat - army.pos.lat) * ratio;
                army.pos.lng += (targetLng - army.pos.lng) * ratio;
            }
        });

        // 🌟 5. 部隊の合流（目標が城の場合は包囲を意図しているため合流しない）
        for (let i = 0; i < GameState.armies.length; i++) {
            for (let j = i + 1; j < GameState.armies.length; j++) {
                let a1 = GameState.armies[i]; let a2 = GameState.armies[j];
                if (a1.troops <= 0 || a2.troops <= 0) continue;
                
                if (a1.faction === a2.faction) {
                    let dist = map.distance(L.latLng(a1.pos.lat, a1.pos.lng), L.latLng(a2.pos.lat, a2.pos.lng));
                    if (dist < 500) { 
                        // 片方が輸送隊なら無条件で物資を渡して消滅
                        if (a1.task === 'transport' || a2.task === 'transport') {
                            let trans = a1.task === 'transport' ? a1 : a2;
                            let recv = a1.task === 'transport' ? a2 : a1;
                            recv.troops += trans.troops; recv.gold += trans.gold; recv.food += trans.food;
                            trans.troops = 0;
                            if(recv.faction === GameState.playerFaction) this.log(`<span style="color:#27ae60;">🛒 輸送隊が味方部隊に接触し、物資を補給しました！</span>`);
                        }
                        // どちらも城を目標としていない場合のみマージ
                        else if (!a1.targetNodeId && !a2.targetNodeId) {
                            if (a1.troops >= a2.troops) {
                                a1.troops += a2.troops; a1.gold += a2.gold; a1.food += a2.food; a2.troops = 0;
                            } else {
                                a2.troops += a1.troops; a2.gold += a1.gold; a2.food += a1.food; a1.troops = 0;
                            }
                        }
                    }
                }
            }
        }

        this.resolveBattlesInTick();
        GameState.armies = GameState.armies.filter(a => a.troops > 0);

        if (typeof window.updateDynamicVisuals === 'function') window.updateDynamicVisuals();
        updateUI();

        GameState.day++;
        if (GameState.day > 30) { GameState.day = 1; this.finalizeMonth(); }
    },

    resolveBattlesInTick: function() {
        let nodeDefensePower = {}; 
        GameState.armies.forEach(a => {
            const node = getClosestNode(a.pos);
            const dist = map.distance(L.latLng(a.pos.lat, a.pos.lng), L.latLng(node.lat, node.lng));
            if (dist < 200) {
                if (!nodeDefensePower[node.id]) nodeDefensePower[node.id] = {};
                if (!nodeDefensePower[node.id][a.faction]) nodeDefensePower[node.id][a.faction] = { troops: 0, ids: [] };
                nodeDefensePower[node.id][a.faction].troops += a.troops;
                nodeDefensePower[node.id][a.faction].ids.push(a.id);
            }
        });

        GameState.armies.forEach(army => {
            if (army.troops <= 0) return;
            const node = getClosestNode(army.pos);
            if (!node || node.type === "5" || node.type === "0") return;
            
            const dist = map.distance(L.latLng(army.pos.lat, army.pos.lng), L.latLng(node.lat, node.lng));
            if (dist < 200) { 
                const castle = GameState.castles[node.id];

                // 味方の城への入城・輸送
                if (castle.faction === army.faction) {
                    if (army.task === 'transport' || (army.pathQueue.length === 0 && !army.targetLatLng && !army.targetArmyId)) {
                        castle.troops += army.troops;
                        castle.gold += army.gold; castle.food += army.food; // 城の備蓄に納入
                        army.troops = 0; 
                        if(army.task === 'transport' && castle.faction === GameState.playerFaction) {
                            this.log(`<span style="color:#3498db;">🚚 輸送隊が ${castle.name} に到着し、物資を納入しました。</span>`);
                        }
                        return;
                    }
                } else if (!areAllies(army.faction, castle.faction)) {
                    army.pathQueue = []; army.targetLatLng = null; army.targetArmyId = null; // 攻城開始
                    
                    let totalDefendingTroops = castle.troops;
                    let alliesAtNode = [];
                    
                    if (nodeDefensePower[node.id]) {
                        Object.keys(nodeDefensePower[node.id]).forEach(fac => {
                            if (fac === castle.faction || areAllies(fac, castle.faction)) {
                                nodeDefensePower[node.id][fac].ids.forEach(aid => {
                                    let allyArmy = GameState.armies.find(a => a.id === aid);
                                    if (allyArmy && allyArmy.id !== army.id) {
                                        totalDefendingTroops += allyArmy.troops;
                                        alliesAtNode.push(allyArmy);
                                    }
                                });
                            }
                        });
                    }

                    if (castle.troops > army.troops && castle.loyalty >= 40) {
                        const sortieTroops = Math.floor(castle.troops * 0.8);
                        castle.troops -= sortieTroops;
                        const defArmy = {
                            id: "army_" + (GameState.armyIdCounter++), faction: castle.faction, troops: sortieTroops,
                            gold: 0, food: Math.floor(castle.food * 0.1), // 迎撃部隊にも少し持たせる
                            pos: { lat: node.lat, lng: node.lng }, pathQueue: [], targetNodeId: null, targetLatLng: null, targetArmyId: null, task: 'attack'
                        };
                        GameState.armies.push(defArmy);
                        this.log(`<span class="log-combat">🐎 <b>${castle.name}</b> の守備隊が城を打って出ました！野戦に持ち込みます！</span>`);
                        if(typeof window.updateDynamicVisuals === 'function') window.updateDynamicVisuals();
                        return; 
                    }

                    let attTraits = getFactionTraits(army.faction);
                    let defTraits = getFactionTraits(castle.faction);
                    let isUnderConstruction = GameState.tasks.some(t => t.castleId === castle.id);
                    let defVal = isUnderConstruction ? castle.defense * 0.8 : castle.defense;

                    if (castle.siegeHP > 0) {
                        let counterMult = (castle.type === "1") ? 1.5 : ((castle.type === "3" || castle.type === "4") ? 0.5 : 1.0);
                        const attrition = Math.max(1, Math.floor(army.troops * 0.01) + Math.floor(totalDefendingTroops * 0.02 * counterMult));
                        army.troops = Math.max(0, army.troops - attrition);

                        const damage = Math.floor((army.troops * 0.05 * attTraits.combat_bonus * (0.8 + Math.random() * 0.4)) / (defVal / 100));
                        castle.siegeHP = Math.max(0, castle.siegeHP - damage);
                        addHate(castle.faction, army.faction, 2);

                        alliesAtNode.forEach(a => {
                            a.troops = Math.max(0, Math.floor(a.troops - (attrition * 0.05)));
                        });

                        if (GameState.day % 5 === 0 && typeof window.showFloatingText === 'function') {
                            window.showFloatingText(army.pos.lat, army.pos.lng, `-${attrition*5}`, "#e74c3c");
                        }
                    } else {
                        const attPower = army.troops * (0.8 + Math.random() * 0.4) * attTraits.combat_bonus;
                        const defPower = totalDefendingTroops * (0.8 + Math.random() * 0.4) * defTraits.defense_bonus * 1.2; 
                        
                        if (attPower > defPower) {
                            const totalLoss = Math.floor(totalDefendingTroops * 0.3);
                            let castleLoss = Math.floor(totalLoss * (castle.troops / totalDefendingTroops));
                            castle.troops = Math.max(0, castle.troops - castleLoss);
                            
                            alliesAtNode.forEach(a => {
                                let allyLoss = Math.floor(totalLoss * (a.troops / totalDefendingTroops));
                                a.troops = Math.max(0, a.troops - allyLoss);
                            });
                            
                            army.troops = Math.floor(army.troops * 0.9);
                            
                            if (castle.troops <= 10) {
                                // 🌟 占領時、城の備蓄をすべて奪う
                                army.gold += castle.gold; army.food += castle.food;
                                castle.gold = 0; castle.food = 0;
                                castle.troops = 0;
                                addHate(castle.faction, army.faction, 500); 
                                
                                Object.keys(FactionMaster).forEach(f => {
                                    if (f !== army.faction && f !== castle.faction && f !== 'independent') addHate(f, army.faction, 50); 
                                });

                                castle.faction = army.faction; 
                                castle._flash = true; 
                                if(typeof window.showFloatingText === 'function') {
                                    const nDef = window.rawNodes.find(n => n.id === castle.id);
                                    window.showFloatingText(nDef.lat, nDef.lng, "🎊 占領", FactionMaster[army.faction].color);
                                }
                                army.troops = Math.floor(army.troops * 0.8);
                                castle.siegeHP = Math.floor(castle.maxSiegeHP * 0.25); 
                                castle.loyalty = 50; 
                                GameState.tasks = GameState.tasks.filter(t => t.castleId !== castle.id);

                                this.log(`<span class="log-combat">🎊 <b>${FactionMaster[army.faction].name}</b>が ${castle.name} を占領し、蔵の物資を接収しました！</span>`);
                                drawMap(); 
                            }
                        } else {
                            castle.troops = Math.floor(castle.troops * 0.9);
                            alliesAtNode.forEach(a => a.troops = Math.floor(a.troops * 0.9));
                            army.troops = Math.floor(army.troops * 0.8);
                        }
                    }
                    return; 
                }
            }
        });

        // 🌟 野戦（略奪処理を含む）
        for(let i=0; i<GameState.armies.length; i++) {
            for(let j=i+1; j<GameState.armies.length; j++) {
                let a1 = GameState.armies[i]; let a2 = GameState.armies[j];
                if (a1.troops <= 0 || a2.troops <= 0 || areAllies(a1.faction, a2.faction)) continue;

                if (map.distance(L.latLng(a1.pos.lat, a1.pos.lng), L.latLng(a2.pos.lat, a2.pos.lng)) < 1000) { 
                    const t1 = getFactionTraits(a1.faction); const t2 = getFactionTraits(a2.faction);
                    
                    // 🌟 輸送隊は弱体化
                    let att1 = a1.troops * (0.8 + Math.random() * 0.4) * t1.combat_bonus * (a1.task === 'transport' ? 0.3 : 1.0);
                    let att2 = a2.troops * (0.8 + Math.random() * 0.4) * t2.combat_bonus * (a2.task === 'transport' ? 0.3 : 1.0);
                    
                    let loser = null; let winner = null;
                    if (att1 > att2) { 
                        a2.troops = Math.floor(a2.troops * (a2.task === 'transport' ? 0.1 : 0.3)); // 輸送隊は即壊滅レベル
                        a1.troops = Math.floor(a1.troops * 0.8); 
                        if(a2.troops <= 10) { a2.troops = 0; loser = a2; winner = a1; }
                    } else { 
                        a1.troops = Math.floor(a1.troops * (a1.task === 'transport' ? 0.1 : 0.3)); 
                        a2.troops = Math.floor(a2.troops * 0.8); 
                        if(a1.troops <= 10) { a1.troops = 0; loser = a1; winner = a2; }
                    }
                    
                    // 🌟 略奪処理（勝者が敗者の物資の70%を奪う）
                    if (winner && loser) {
                        let stolenGold = Math.floor(loser.gold * 0.7);
                        let stolenFood = Math.floor(loser.food * 0.7);
                        winner.gold += stolenGold; winner.food += stolenFood;
                        loser.gold = 0; loser.food = 0;
                        if(winner.faction === GameState.playerFaction && (stolenGold > 0 || stolenFood > 0)) {
                            this.log(`<span style="color:#f39c12;">💰 敵部隊を撃破し、金${stolenGold}・兵糧${stolenFood} を奪い取りました！</span>`);
                        }
                    }
                    
                    a1.pathQueue = []; a2.pathQueue = [];
                    a1.targetLatLng = null; a2.targetLatLng = null;
                    addHate(a1.faction, a2.faction, 10); addHate(a2.faction, a1.faction, 10);

                    // 支援射撃
                    [a1, a2].forEach(targetArmy => {
                        const opponent = (targetArmy === a1) ? a2 : a1;
                        const nearbyNode = getClosestNode(targetArmy.pos);
                        if (map.distance(L.latLng(targetArmy.pos.lat, targetArmy.pos.lng), L.latLng(nearbyNode.lat, nearbyNode.lng)) < 500) {
                            const nearbyCastle = GameState.castles[nearbyNode.id];
                            if (areAllies(nearbyCastle.faction, opponent.faction) && nearbyCastle.faction !== targetArmy.faction) {
                                const supportDmg = Math.floor(nearbyCastle.troops * 0.02);
                                targetArmy.troops = Math.max(0, targetArmy.troops - supportDmg);
                            }
                        }
                    });

                    if(typeof window.showFloatingText === 'function') window.showFloatingText(a1.pos.lat, a1.pos.lng, "⚔️ 激突", "#e74c3c");
                }
            }
        }
    },

    runAI: function() {
        let pIdx = GameState.priceIndex;

        // 🌟 援軍要請
        Object.values(GameState.castles).forEach(castle => {
            if (castle.faction === 'independent') return;
            let isAttacked = GameState.armies.some(a => a.faction !== castle.faction && a.targetNodeId === castle.id);
            if (isAttacked) {
                Object.keys(FactionMaster).forEach(allyFaction => {
                    if (allyFaction === castle.faction || allyFaction === 'independent') return;
                    let level = window.getAllianceLevel(castle.faction, allyFaction);
                    if (level >= 2 && castle.gold >= Math.floor(100 * pIdx)) {
                        let alreadySending = GameState.armies.some(a => a.faction === allyFaction && a.targetNodeId === castle.id);
                        if (alreadySending) return;

                        let acceptProb = (level === 3) ? 0.9 : 0.5;
                        if (Math.random() < acceptProb) {
                            castle.gold -= Math.floor(100 * pIdx);
                            addFriendship(castle.faction, allyFaction, 100); addFriendship(allyFaction, castle.faction, 100);
                            
                            let bestAllyCastle = null; let minDist = Infinity;
                            const cNode = window.rawNodes.find(n => n.id === castle.id);
                            Object.values(GameState.castles).forEach(ac => {
                                if (ac.faction === allyFaction && ac.troops > 1000) {
                                    const aNode = window.rawNodes.find(n => n.id === ac.id);
                                    const dist = map.distance(L.latLng(cNode.lat, cNode.lng), L.latLng(aNode.lat, aNode.lng));
                                    if (dist < 40000 && dist < minDist) { minDist = dist; bestAllyCastle = ac; }
                                }
                            });
                            
                            if (bestAllyCastle) {
                                const route = findShortestPath(bestAllyCastle.id, castle.id);
                                if (route) {
                                    let sendTroops = Math.floor(bestAllyCastle.troops * (level === 3 ? 0.6 : 0.3));
                                    let carryFood = Math.floor(bestAllyCastle.food * 0.3); // 援軍も兵糧持参
                                    const allyArmy = window.deployArmy(bestAllyCastle.id, sendTroops, true, 'attack', 0, carryFood);
                                    if (allyArmy) {
                                        allyArmy.pathQueue = route; allyArmy.targetNodeId = castle.id;
                                        this.log(`<span class="log-ai">🤝 ${FactionMaster[allyFaction].name} が要請に応じ、${castle.name} へ援軍を派遣！</span>`);
                                    }
                                }
                            }
                        } else {
                            castle.gold -= Math.floor(10 * pIdx); 
                            addHate(castle.faction, allyFaction, 200);
                        }
                    }
                });
            }
        });

        let isFrontline = {};
        Object.values(GameState.castles).forEach(c => {
            isFrontline[c.id] = false;
            const cNode = window.rawNodes.find(n => n.id === c.id);
            Object.values(GameState.castles).forEach(e => {
                if (e.faction !== c.faction && e.faction !== 'independent') {
                    const eNode = window.rawNodes.find(n => n.id === e.id);
                    if (map.distance(L.latLng(cNode.lat, cNode.lng), L.latLng(eNode.lat, eNode.lng)) < 40000) isFrontline[c.id] = true;
                }
            });
        });

        Object.values(GameState.castles).forEach(castle => {
            if(castle.faction === 'independent') return;
            const maxT = getMaxTroops(castle);
            const deployableTroops = Math.floor(castle.troops * 0.7); 

            // 🌟 1. 輸送・ハイエナ襲撃ロジック
            if (!isFrontline[castle.id] && castle.troops > 1000 && castle.food > 2000) {
                let bestDest = null; let minDist = Infinity;
                const cNode = window.rawNodes.find(n => n.id === castle.id);
                Object.values(GameState.castles).forEach(a => {
                    if (a.faction === castle.faction && isFrontline[a.id]) {
                        const aNode = window.rawNodes.find(n => n.id === a.id);
                        const dist = map.distance(L.latLng(cNode.lat, cNode.lng), L.latLng(aNode.lat, aNode.lng));
                        if (dist < minDist) { minDist = dist; bestDest = a; }
                    }
                });
                if (bestDest) {
                    const route = findShortestPath(castle.id, bestDest.id);
                    if (route) {
                        let sendFood = Math.floor(castle.food * 0.4);
                        const tArmy = window.deployArmy(castle.id, 500, true, 'transport', 0, sendFood);
                        if (tArmy) {
                            tArmy.pathQueue = route; tArmy.targetNodeId = bestDest.id;
                            this.log(`<span class="log-ai">🚚 ${FactionMaster[castle.faction].name} が前線の ${bestDest.name} へ兵糧${sendFood}の輸送隊を派遣！</span>`);
                        }
                    }
                }
            } else if (isFrontline[castle.id] && castle.troops > 800) {
                // 敵の輸送隊を狙う
                const cNode = window.rawNodes.find(n => n.id === castle.id);
                let targetTrans = null;
                GameState.armies.forEach(a => {
                    if (a.task === 'transport' && a.faction !== castle.faction && !areAllies(a.faction, castle.faction)) {
                        if (map.distance(L.latLng(cNode.lat, cNode.lng), L.latLng(a.pos.lat, a.pos.lng)) < 15000) {
                            targetTrans = a;
                        }
                    }
                });
                if (targetTrans) {
                    const rArmy = window.deployArmy(castle.id, 500, true, 'pursuit', 0, Math.floor(castle.food * 0.1));
                    if (rArmy) {
                        rArmy.targetArmyId = targetTrans.id;
                        this.log(`<span class="log-ai">🐎 ${FactionMaster[castle.faction].name} が敵の輸送隊を襲撃すべく出陣！</span>`);
                    }
                }
            }

            // 🌟 2. 内政ロジック（城の備蓄から支払う）
            if(GameState.playerFaction === null || castle.faction !== GameState.playerFaction) {
                if (!GameState.tasks.some(t => t.castleId === castle.id)) {
                    let repCost = Math.floor(25 * pIdx); let defCost = Math.floor(100 * pIdx); let agrCost = Math.floor(25 * pIdx);
                    if (castle.siegeHP < castle.maxSiegeHP && castle.gold >= repCost * 2) {
                        castle.gold -= repCost;
                        GameState.tasks.push({ type: 'repair', castleId: castle.id, faction: castle.faction, daysLeft: 15, finishCost: repCost });
                    }
                    else if (castle.troops < maxT * 0.5 && castle.gold >= Math.floor(100 * pIdx) && castle.food >= Math.floor(50 * pIdx) && castle.loyalty >= 50) {
                        castle.gold -= Math.floor(100 * pIdx); castle.food -= Math.floor(50 * pIdx);
                        castle.troops = Math.min(maxT, castle.troops + 300); castle.loyalty -= 10;
                    }
                    else if (castle.gold >= agrCost * 2 + Math.floor(100 * pIdx)) {
                        castle.gold -= agrCost;
                        GameState.tasks.push({ type: 'agriculture', castleId: castle.id, faction: castle.faction, daysLeft: 30, finishCost: agrCost });
                    }
                    else if (castle.gold >= defCost * 2 + Math.floor(500 * pIdx)) {
                        castle.gold -= defCost;
                        GameState.tasks.push({ type: 'defense', castleId: castle.id, faction: castle.faction, daysLeft: 45, finishCost: defCost });
                    }
                }
            }

            // 🌟 3. 侵攻・集結（後詰）ロジック
            const traits = getFactionTraits(castle.faction); 
            if (castle.troops < 500 || castle.troops < maxT * traits.wait_threshold || Math.random() > 0.4 * traits.aggression) return; 

            let estimatedFoodCost = Math.floor((deployableTroops / 100) * 3 * pIdx * 90);
            if (castle.food < estimatedFoodCost * 1.5) return; // 遠征用の兵糧がない

            let candidates = Object.values(GameState.castles)
                .filter(t => t.faction !== castle.faction && !areAllies(castle.faction, t.faction))
                .map(t => {
                    const tNode = window.rawNodes.find(n => n.id === t.id);
                    const dist = map.distance(L.latLng(window.rawNodes.find(n=>n.id===castle.id).lat, window.rawNodes.find(n=>n.id===castle.id).lng), L.latLng(tNode.lat, tNode.lng)) / 1000;
                    return { castle: t, dist: dist };
                })
                .sort((a, b) => a.dist - b.dist).slice(0, 5); 

            let bestTarget = null; let bestScore = -Infinity;

            candidates.forEach(cand => {
                const targetCastle = cand.castle;
                const route = findShortestPath(castle.id, targetCastle.id);
                if (!route) return;

                let enemyStrength = targetCastle.troops + (targetCastle.siegeHP * 0.5); 
                if (GameState.tasks.some(t => t.castleId === targetCastle.id)) enemyStrength *= 0.8;
                if (deployableTroops < enemyStrength * 1.2 && targetCastle.faction !== 'independent') return;

                const totalCost = route.reduce((sum, r) => sum + (r.dist / r.speedMod), 0);
                const hateBonus = (GameState.hateMatrix[castle.faction]?.[targetCastle.faction] || 0) * 10;
                const score = (10000 / (totalCost + 1)) - enemyStrength + hateBonus;
                if (score > bestScore) { bestScore = score; bestTarget = { id: targetCastle.id, route: route }; }
            });

            if (bestTarget) {
                const army = window.deployArmy(castle.id, deployableTroops, true, 'attack', 0, estimatedFoodCost);
                if (army) {
                    army.pathQueue = bestTarget.route; army.targetNodeId = bestTarget.id;
                    this.log(`<span class="log-ai">【出陣】${FactionMaster[castle.faction].name}が ${GameState.castles[bestTarget.id].name} へ侵攻開始！</span>`);
                    
                    const cNode = window.rawNodes.find(n => n.id === castle.id);
                    Object.values(GameState.castles).forEach(allyC => {
                        if (allyC.faction === castle.faction && allyC.id !== castle.id && allyC.troops > 800) {
                            const aNode = window.rawNodes.find(n => n.id === allyC.id);
                            if (map.distance(L.latLng(cNode.lat, cNode.lng), L.latLng(aNode.lat, aNode.lng)) < 30000) { 
                                const aRoute = findShortestPath(allyC.id, bestTarget.id);
                                if (aRoute) {
                                    let subFood = Math.floor((allyC.troops*0.5/100) * 3 * pIdx * 90);
                                    if(allyC.food > subFood) {
                                        const allyArmy = window.deployArmy(allyC.id, Math.floor(allyC.troops * 0.5), true, 'attack', 0, subFood);
                                        if (allyArmy) { allyArmy.pathQueue = aRoute; allyArmy.targetNodeId = bestTarget.id; }
                                    }
                                }
                            }
                        }
                    });
                }
            }
        });
    },

    finalizeMonth: function() {
        GameState.month++; if (GameState.month > 12) { GameState.month = 1; GameState.year++; }
        let pIdx = GameState.priceIndex;
        const isAutumnHarvest = (GameState.month === 9); 
        
        let playerGoldIn = 0; let playerFoodIn = 0;

        // 🌟 城ごとに収入と上限キャップを処理
        Object.values(GameState.castles).forEach(castle => {
            if (castle.siegeHP < castle.maxSiegeHP * 0.25) {
                castle.siegeHP = Math.min(Math.floor(castle.maxSiegeHP * 0.25), Math.floor(castle.siegeHP + castle.maxSiegeHP * 0.05));
            }
            if (castle.faction === "independent") return;
            
            let loyMult = Math.max(0.2, castle.loyalty / 100);
            let monthGold = Math.floor(castle.commerce * 0.2 * loyMult * pIdx);
            castle.gold += monthGold;
            if(castle.faction === GameState.playerFaction) playerGoldIn += monthGold;

            if(isAutumnHarvest) {
                let autumnFood = Math.floor(castle.currentKokudaka * 1.0 * loyMult * pIdx);
                castle.food += autumnFood;
                if(castle.faction === GameState.playerFaction) playerFoodIn += autumnFood;
            }
            // 🌟 備蓄上限（兵糧は石高の5倍）
            castle.food = Math.min(castle.food, castle.currentKokudaka * 5);

            const maxTroops = getMaxTroops(castle);
            const traits = getFactionTraits(castle.faction);
            if (castle.loyalty >= 50 && castle.troops < maxTroops) {
                let rec = (castle.faction === GameState.playerFaction) ? Math.floor(maxTroops * 0.05) : Math.floor((maxTroops * 0.05 + 10) * traits.recruit_bonus);
                castle.troops = Math.min(maxTroops, castle.troops + rec); 
            }

            if (castle.loyalty < 40 && Math.random() < 0.2) {
                const nodeDef = window.rawNodes.find(n => n.id === castle.id);
                const ikkiArmy = {
                    id: "army_" + (GameState.armyIdCounter++), faction: "independent", troops: 500 + Math.floor(Math.random()*500),
                    gold: 0, food: 1000, pos: { lat: nodeDef.lat + 0.005, lng: nodeDef.lng + 0.005 }, 
                    pathQueue: window.findShortestPath(getClosestNode({lat: nodeDef.lat, lng: nodeDef.lng}).id, castle.id) || [], 
                    targetNodeId: castle.id, targetLatLng: null, targetArmyId: null, task: 'attack'
                };
                GameState.armies.push(ikkiArmy);
                this.log(`<span style="color:#e74c3c;">🔥 <b>${castle.name}</b> の周辺で<b>一揆</b>が発生！</span>`);
            }
        });

        if (GameState.playerFaction) {
            if(playerGoldIn > 0) this.log(`<span style="color:#f1c40f;">商いにより、各城に合計 金${playerGoldIn} が納められました。</span>`);
            if(isAutumnHarvest && playerFoodIn > 0) this.log(`<span style="color:#d35400;">🌾 秋の収穫！各城に合計 兵糧${playerFoodIn} が納められました。</span>`);
        }

        // 外交感情の自然減衰
        for (let f1 in GameState.hateMatrix) {
            for (let f2 in GameState.hateMatrix[f1]) {
                if(GameState.hateMatrix[f1][f2] > 0) { GameState.hateMatrix[f1][f2] = Math.max(0, GameState.hateMatrix[f1][f2] - 10); }
            }
        }
        for (let f1 in GameState.friendshipMatrix) {
            for (let f2 in GameState.friendshipMatrix[f1]) {
                if(GameState.friendshipMatrix[f1][f2] > 0) { GameState.friendshipMatrix[f1][f2] = Math.max(0, GameState.friendshipMatrix[f1][f2] - 5); }
            }
        }

        const factions = Object.keys(FactionMaster).filter(f => f !== 'independent');
        let factionCastleCount = {}; let totalCastles = 0;
        Object.values(GameState.castles).forEach(c => {
            if(c.faction !== 'independent') { factionCastleCount[c.faction] = (factionCastleCount[c.faction] || 0) + 1; totalCastles++; }
        });
        let avgCastles = totalCastles / (factions.length || 1);

        Object.values(GameState.castles).forEach(c => {
            if (c.faction === 'independent') return;
            window.graph[c.id].forEach(edge => {
                let neighbor = GameState.castles[edge.to];
                if (neighbor && neighbor.faction !== 'independent' && neighbor.faction !== c.faction) addHate(c.faction, neighbor.faction, 10); 
            });
        });

        factions.forEach(f1 => {
            let count = factionCastleCount[f1] || 0;
            if (count > avgCastles * 1.5) {
                factions.forEach(f2 => { if (f1 !== f2) addHate(f2, f1, Math.floor(count / 2)); });
            }
        });

        for(let i=0; i<factions.length; i++) {
            for(let j=i+1; j<factions.length; j++) {
                let f1 = factions[i], f2 = factions[j];
                let hasCommonThreat = false;
                let powerF1 = (factionCastleCount[f1]||0); let powerF2 = (factionCastleCount[f2]||0);
                
                for(let enemy of factions) {
                    if (enemy === f1 || enemy === f2) continue;
                    let powerE = (factionCastleCount[enemy]||0);
                    let h1 = GameState.hateMatrix[f1]?.[enemy] || 0; let h2 = GameState.hateMatrix[f2]?.[enemy] || 0;
                    if (h1 > 200 && h2 > 200 && powerE > (powerF1 + powerF2) * 0.8) { hasCommonThreat = true; break; }
                }
                if (hasCommonThreat) {
                    addFriendship(f1, f2, 50); addFriendship(f2, f1, 50);
                }
            }
        }

        GameState.alliances = {};
        for(let i=0; i<factions.length; i++) {
            for(let j=i+1; j<factions.length; j++) {
                let f1 = factions[i], f2 = factions[j];
                let mutualScore = (window.getDiplomacyScore(f1, f2) + window.getDiplomacyScore(f2, f1)) / 2;
                
                let level = 0;
                if (mutualScore >= 800) level = 3;
                else if (mutualScore >= 500) level = 2;
                else if (mutualScore >= 300) level = 1;
                
                if (level > 0) {
                    GameState.alliances[`${f1}-${f2}`] = level;
                    // 同盟維持費（本城から引くなど）は簡略化のため省略またはランダムな城から引く
                    let myCastles = Object.values(GameState.castles).filter(c => c.faction === f1);
                    if(myCastles.length>0) myCastles[0].gold = Math.max(0, myCastles[0].gold - Math.floor(20*pIdx));
                }
            }
        }

        if(typeof window.updateStatsTable === 'function' && !document.getElementById('stats-modal').classList.contains('modal-hidden')) window.updateStatsTable();
        updateUI(); drawMap();
    }
};
