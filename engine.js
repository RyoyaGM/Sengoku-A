// --- engine.js: 合流・輸送・街道待機・完全整数化 実装版 ---

const GameState = {
    isLoaded: false, hasStarted: false, isPaused: true,
    year: 1560, month: 1, day: 1, gold: 3000, castles: {}, armies: [], armyIdCounter: 1,
    playerFaction: null, alliances: new Set(), hateMatrix: {}, factionsInfo: {},
    priceIndex: 1.0, tasks: [] 
};

function addHate(fromFaction, toFaction, amount) {
    if (fromFaction === toFaction || fromFaction === 'independent' || toFaction === 'independent') return;
    if (!GameState.hateMatrix[fromFaction]) GameState.hateMatrix[fromFaction] = {};
    GameState.hateMatrix[fromFaction][toFaction] = (GameState.hateMatrix[fromFaction][toFaction] || 0) + amount;
}

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

        let isWinter = (GameState.month === 12 || GameState.month <= 2);
        const dailyMoveBase = isWinter ? 3 : 6; 

        // 🌟 兵糧消費（軍勢維持費）- 完全整数化
        Object.keys(GameState.factionsInfo).forEach(f => {
            let info = GameState.factionsInfo[f];
            let dailyFoodCost = 0;
            
            Object.values(GameState.castles).forEach(c => {
                if (c.faction === f) dailyFoodCost += (c.troops / 100) * 1 * GameState.priceIndex;
            });
            GameState.armies.forEach(a => {
                if (a.faction === f) dailyFoodCost += (a.troops / 100) * 3 * GameState.priceIndex;
            });
            
            info.food -= Math.floor(dailyFoodCost);
            
            if (info.food <= 0) {
                info.food = 0;
                Object.values(GameState.castles).forEach(c => { if (c.faction === f) c.troops = Math.max(0, Math.floor(c.troops * 0.98)); });
                GameState.armies.forEach(a => { if (a.faction === f) a.troops = Math.max(0, Math.floor(a.troops * 0.98)); });
                if (GameState.day === 1 && f === GameState.playerFaction) this.log(`<span style="color:#e74c3c;">⚠️ 兵糧が尽き、飢餓により兵士が脱走しています！</span>`);
            }
        });

        // 工期タスクの進行
        for (let i = GameState.tasks.length - 1; i >= 0; i--) {
            let t = GameState.tasks[i];
            t.daysLeft--;
            if (t.daysLeft <= 0) {
                let info = GameState.factionsInfo[t.faction];
                if (info && info.gold >= t.finishCost) {
                    info.gold -= t.finishCost; // 既にMath.floorされている
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
                } else {
                    if(t.faction === GameState.playerFaction) this.log(`【中断】資金不足のため工事が中止されました。`);
                }
                GameState.tasks.splice(i, 1);
            }
        }

        // 🌟 移動ロジック（街道の任意の座標への移動・待機対応）
        GameState.armies.forEach(army => {
            if (army.troops <= 0) return;

            let nextStep = army.pathQueue[0];
            let targetLat, targetLng, speedMod = 1.0;

            if (nextStep) {
                let nInfo = window.rawNodes.find(n => n.id === nextStep.nodeId);
                targetLat = nInfo.lat; targetLng = nInfo.lng;
                speedMod = nextStep.speedMod;
            } else if (army.targetLatLng) {
                targetLat = army.targetLatLng.lat; targetLng = army.targetLatLng.lng;
            } else {
                return; // 完全に到着し、留まっている
            }

            let distToNext = map.distance(L.latLng(army.pos.lat, army.pos.lng), L.latLng(targetLat, targetLng)) / 1000;
            if(distToNext < 0.1) distToNext = 0;

            let dailyMove = dailyMoveBase * speedMod;

            if (dailyMove >= distToNext) {
                army.pos = { lat: targetLat, lng: targetLng };
                if (army.pathQueue.length > 0) {
                    army.pathQueue.shift();
                } else if (army.targetLatLng) {
                    army.targetLatLng = null; // 座標に到着し、待機状態へ
                    army.task = 'hold';
                }
            } else {
                let ratio = distToNext === 0 ? 0 : dailyMove / distToNext;
                army.pos.lat += (targetLat - army.pos.lat) * ratio;
                army.pos.lng += (targetLng - army.pos.lng) * ratio;
            }
        });

        // 🌟 部隊の合流（Merging）ロジック
        for (let i = 0; i < GameState.armies.length; i++) {
            for (let j = i + 1; j < GameState.armies.length; j++) {
                let a1 = GameState.armies[i]; let a2 = GameState.armies[j];
                if (a1.troops <= 0 || a2.troops <= 0) continue;
                
                // 同一勢力 ＆ 輸送任務ではない ＆ 距離0.5km以内なら合流
                if (a1.faction === a2.faction && a1.task !== 'transport' && a2.task !== 'transport') {
                    let dist = map.distance(L.latLng(a1.pos.lat, a1.pos.lng), L.latLng(a2.pos.lat, a2.pos.lng));
                    if (dist < 500) { 
                        if (a1.troops >= a2.troops) {
                            a1.troops += a2.troops; a2.troops = 0;
                        } else {
                            a2.troops += a1.troops; a1.troops = 0;
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
        GameState.armies.forEach(army => {
            if (army.troops <= 0) return;
            const node = getClosestNode(army.pos);
            if (!node || node.type === "5" || node.type === "0") return;
            
            const dist = map.distance(L.latLng(army.pos.lat, army.pos.lng), L.latLng(node.lat, node.lng));
            if (dist < 200) { 
                const castle = GameState.castles[node.id];

                // 🌟 味方の城に到着した場合の処理（輸送隊は入城して消滅、防衛隊も入城）
                if (castle.faction === army.faction) {
                    if (army.task === 'transport' || (army.pathQueue.length === 0 && !army.targetLatLng)) {
                        castle.troops += army.troops; army.troops = 0; 
                        if(army.task === 'transport' && castle.faction === GameState.playerFaction) {
                            this.log(`<span style="color:#3498db;">🚚 輸送隊が ${castle.name} に到着し、守備隊に合流しました。</span>`);
                        }
                    }
                } else if (!areAllies(army.faction, castle.faction)) {
                    army.pathQueue = []; army.targetLatLng = null; // 攻城開始
                    
                    if (castle.troops > army.troops && castle.loyalty >= 40) {
                        const sortieTroops = Math.floor(castle.troops * 0.8);
                        castle.troops -= sortieTroops;
                        const defArmy = {
                            id: "army_" + (GameState.armyIdCounter++), faction: castle.faction, troops: sortieTroops,
                            pos: { lat: node.lat, lng: node.lng }, pathQueue: [], targetNodeId: null, targetLatLng: null, task: 'attack'
                        };
                        GameState.armies.push(defArmy);
                        this.log(`<span class="log-combat">🐎 <b>${castle.name}</b> の守備隊が城を打って出ました！野戦に持ち込みます！</span>`);
                        if(typeof window.updateDynamicVisuals === 'function') window.updateDynamicVisuals();
                        return; 
                    }

                    const attTraits = getFactionTraits(army.faction);
                    const defTraits = getFactionTraits(castle.faction);
                    let isUnderConstruction = GameState.tasks.some(t => t.castleId === castle.id);
                    let defVal = isUnderConstruction ? castle.defense * 0.8 : castle.defense;

                    if (castle.siegeHP > 0) {
                        let counterMult = 1.0;
                        if(castle.type === "1") counterMult = 1.5; 
                        else if(castle.type === "3" || castle.type === "4") counterMult = 0.5;

                        const attrition = Math.max(1, Math.floor(army.troops * 0.01) + Math.floor(castle.troops * 0.02 * counterMult));
                        army.troops = Math.max(0, army.troops - attrition);

                        const damage = Math.floor((army.troops * 0.05 * attTraits.combat_bonus * (0.8 + Math.random() * 0.4)) / (defVal / 100));
                        castle.siegeHP = Math.max(0, castle.siegeHP - damage);
                        addHate(castle.faction, army.faction, 2);

                        if (GameState.day % 5 === 0 && typeof window.showFloatingText === 'function') {
                            window.showFloatingText(army.pos.lat, army.pos.lng, `-${attrition*5}`, "#e74c3c");
                        }
                    } else {
                        const att = army.troops * (0.8 + Math.random() * 0.4) * attTraits.combat_bonus;
                        const def = castle.troops * (0.8 + Math.random() * 0.4) * defTraits.defense_bonus * 1.2; 
                        
                        if (att > def) {
                            castle.troops = Math.floor(castle.troops * 0.6); 
                            army.troops = Math.floor(army.troops * 0.9);
                            
                            if (castle.troops <= 10) {
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

                                this.log(`<span class="log-combat">🎊 <b>${FactionMaster[army.faction].name}</b>が ${castle.name} を占領しました！</span>`);
                                drawMap(); 
                            }
                        } else {
                            castle.troops = Math.floor(castle.troops * 0.9);
                            army.troops = Math.floor(army.troops * 0.8);
                        }
                    }
                }
            }
        });

        // 野戦（衝突）
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
                        
                        // 迎撃部隊などは戦闘後にその場で停止する
                        a1.pathQueue = []; a2.pathQueue = [];
                        a1.targetLatLng = null; a2.targetLatLng = null;
                        
                        addHate(a1.faction, a2.faction, 10); addHate(a2.faction, a1.faction, 10);
                        if(typeof window.showFloatingText === 'function') window.showFloatingText(a1.pos.lat, a1.pos.lng, "⚔️ 激突", "#e74c3c");
                    }
                }
            }
        }
    },

    runAI: function() {
        let pIdx = GameState.priceIndex;

        // 前線判定（事前計算）
        let isFrontline = {};
        Object.values(GameState.castles).forEach(c => {
            isFrontline[c.id] = false;
            const cNode = window.rawNodes.find(n => n.id === c.id);
            Object.values(GameState.castles).forEach(e => {
                if (e.faction !== c.faction && e.faction !== 'independent') {
                    const eNode = window.rawNodes.find(n => n.id === e.id);
                    if (map.distance(L.latLng(cNode.lat, cNode.lng), L.latLng(eNode.lat, eNode.lng)) < 40000) { // 40km以内に敵がいる
                        isFrontline[c.id] = true;
                    }
                }
            });
        });

        Object.values(GameState.castles).forEach(castle => {
            if(castle.faction === 'independent') return;
            const maxT = getMaxTroops(castle);
            const deployableTroops = Math.floor(castle.troops * 0.7); // 🌟 70%まで出撃許可
            let fInfo = GameState.factionsInfo[castle.faction];
            if(!fInfo) return;

            // 🌟 1. 輸送ロジック（後方から前線へ兵を送る）
            if (!isFrontline[castle.id] && castle.troops > 1500) {
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
                        const tArmy = window.deployArmy(castle.id, 1000, true, 'transport');
                        if (tArmy) {
                            tArmy.pathQueue = route; tArmy.targetNodeId = bestDest.id;
                            this.log(`<span class="log-ai">🚚 ${FactionMaster[castle.faction].name} が前線の ${bestDest.name} へ輸送隊を派遣！</span>`);
                        }
                    }
                }
            }

            // 🌟 2. 内政ロジック
            if(GameState.playerFaction === null || castle.faction !== GameState.playerFaction) {
                if (!GameState.tasks.some(t => t.castleId === castle.id)) {
                    let repCost = Math.floor(25 * pIdx); let defCost = Math.floor(100 * pIdx); let agrCost = Math.floor(25 * pIdx);

                    if (castle.siegeHP < castle.maxSiegeHP && fInfo.gold >= repCost * 2 + 50) {
                        fInfo.gold -= repCost;
                        GameState.tasks.push({ type: 'repair', castleId: castle.id, faction: castle.faction, daysLeft: 15, finishCost: repCost });
                    }
                    else if (castle.troops < maxT * 0.5 && fInfo.gold >= Math.floor(100 * pIdx) && fInfo.food >= Math.floor(50 * pIdx) && castle.loyalty >= 50) {
                        fInfo.gold -= Math.floor(100 * pIdx); fInfo.food -= Math.floor(50 * pIdx);
                        castle.troops = Math.min(maxT, castle.troops + 300);
                        castle.loyalty -= 10;
                    }
                    else if (fInfo.gold >= agrCost * 2 + Math.floor(100 * pIdx)) {
                        fInfo.gold -= agrCost;
                        GameState.tasks.push({ type: 'agriculture', castleId: castle.id, faction: castle.faction, daysLeft: 30, finishCost: agrCost });
                    }
                    else if (fInfo.gold >= defCost * 2 + Math.floor(500 * pIdx)) {
                        fInfo.gold -= defCost;
                        GameState.tasks.push({ type: 'defense', castleId: castle.id, faction: castle.faction, daysLeft: 45, finishCost: defCost });
                    }
                }
            }

            // 🌟 3. 侵攻・集結（後詰）ロジック
            const traits = getFactionTraits(castle.faction); 
            const threshold = maxT * traits.wait_threshold;
            if (castle.troops < 300 || castle.troops < threshold || Math.random() > 0.4 * traits.aggression) return; 
            if (fInfo.gold < Math.floor(50 * pIdx)) return; 

            // 兵糧チェック (部隊の120日分があるか)
            let estimatedFoodCost = Math.floor((deployableTroops / 100) * 3 * pIdx * 120);
            if (fInfo.food < estimatedFoodCost) return; 

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

                // 敵の強さを「兵数 + 耐久の半分」とし、工事中なら2割引
                let enemyStrength = targetCastle.troops + (targetCastle.siegeHP * 0.5); 
                let isUnderConst = GameState.tasks.some(t => t.castleId === targetCastle.id);
                if (isUnderConst) enemyStrength *= 0.8;

                if (deployableTroops < enemyStrength * 1.2 && targetCastle.faction !== 'independent') return;

                const totalCost = route.reduce((sum, r) => sum + (r.dist / r.speedMod), 0);
                const hateBonus = (GameState.hateMatrix[castle.faction]?.[targetCastle.faction] || 0) * 10;
                const score = (10000 / (totalCost + 1)) - enemyStrength + hateBonus;
                
                if (score > bestScore) { bestScore = score; bestTarget = { id: targetCastle.id, route: route }; }
            });

            if (bestTarget) {
                const army = window.deployArmy(castle.id, deployableTroops, true, 'attack');
                if (army) {
                    fInfo.gold -= Math.floor(50 * pIdx); 
                    army.pathQueue = bestTarget.route; army.targetNodeId = bestTarget.id;
                    const tName = GameState.castles[bestTarget.id].name;
                    this.log(`<span class="log-ai">【出陣】${FactionMaster[castle.faction].name}が ${tName} へ侵攻開始！</span>`);
                    
                    // 🌟 後詰（周辺の味方城からも一斉出撃して加勢・合流する）
                    const cNode = window.rawNodes.find(n => n.id === castle.id);
                    Object.values(GameState.castles).forEach(allyC => {
                        if (allyC.faction === castle.faction && allyC.id !== castle.id && allyC.troops > 800) {
                            const aNode = window.rawNodes.find(n => n.id === allyC.id);
                            if (map.distance(L.latLng(cNode.lat, cNode.lng), L.latLng(aNode.lat, aNode.lng)) < 30000) { 
                                const aRoute = findShortestPath(allyC.id, bestTarget.id);
                                if (aRoute) {
                                    const allyArmy = window.deployArmy(allyC.id, Math.floor(allyC.troops * 0.5), true, 'attack');
                                    if (allyArmy) {
                                        fInfo.gold -= Math.floor(50 * pIdx);
                                        allyArmy.pathQueue = aRoute; allyArmy.targetNodeId = bestTarget.id;
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
        let incomeGold = {}; let incomeFood = {};
        Object.keys(FactionMaster).forEach(f => { incomeGold[f] = 0; incomeFood[f] = 0; });
        
        Object.values(GameState.castles).forEach(castle => {
            if (castle.siegeHP < castle.maxSiegeHP * 0.25) {
                castle.siegeHP = Math.min(Math.floor(castle.maxSiegeHP * 0.25), Math.floor(castle.siegeHP + castle.maxSiegeHP * 0.05));
            }

            if (castle.faction === "independent") return;
            const maxTroops = getMaxTroops(castle);
            const traits = getFactionTraits(castle.faction);

            let loyMult = Math.max(0.2, castle.loyalty / 100);
            
            if(incomeGold[castle.faction] !== undefined) {
                incomeGold[castle.faction] += Math.floor(castle.commerce * 0.2 * loyMult * pIdx);
            }
            if(isAutumnHarvest && incomeFood[castle.faction] !== undefined) {
                incomeFood[castle.faction] += Math.floor(castle.currentKokudaka * 1.0 * loyMult * pIdx);
            }

            if (castle.loyalty >= 50) {
                if (GameState.playerFaction !== null && castle.faction === GameState.playerFaction) {
                    if (castle.troops < maxTroops) castle.troops = Math.min(maxTroops, castle.troops + Math.floor(maxTroops * 0.05)); 
                } else {
                    const recoveryBase = Math.floor(maxTroops * 0.05 + 10);
                    if (castle.troops < maxTroops) {
                        castle.troops = Math.min(maxTroops, castle.troops + Math.floor(recoveryBase * traits.recruit_bonus)); 
                    }
                }
            }

            if (castle.loyalty < 40 && Math.random() < 0.2) {
                const ikkiTroops = 500 + Math.floor(Math.random() * 500);
                const nodeDef = window.rawNodes.find(n => n.id === castle.id);
                const ikkiArmy = {
                    id: "army_" + (GameState.armyIdCounter++), faction: "independent", troops: ikkiTroops,
                    pos: { lat: nodeDef.lat + 0.005, lng: nodeDef.lng + 0.005 }, pathQueue: [], targetNodeId: castle.id, targetLatLng: null, task: 'attack'
                };
                ikkiArmy.pathQueue = window.findShortestPath(getClosestNode(ikkiArmy.pos).id, castle.id) || [];
                GameState.armies.push(ikkiArmy);
                this.log(`<span style="color:#e74c3c;">🔥 <b>${castle.name}</b> の周辺で圧政に耐えかねた農民による<b>一揆</b>が発生！</span>`);
            }
        });
        
        Object.keys(incomeGold).forEach(f => {
            if(GameState.factionsInfo[f]) {
                GameState.factionsInfo[f].gold += Math.floor(incomeGold[f]);
                GameState.factionsInfo[f].food += Math.floor(incomeFood[f]);
            }
        });

        if (GameState.playerFaction) {
            if(incomeGold[GameState.playerFaction] > 0) this.log(`<span style="color:#f1c40f;">商いにより、資金 ${Math.floor(incomeGold[GameState.playerFaction])} が入りました。</span>`);
            if(isAutumnHarvest && incomeFood[GameState.playerFaction] > 0) this.log(`<span style="color:#d35400;">🌾 秋の収穫！年貢として兵糧 ${Math.floor(incomeFood[GameState.playerFaction])} が入りました。</span>`);
        }

        for (let f1 in GameState.hateMatrix) {
            for (let f2 in GameState.hateMatrix[f1]) {
                if(GameState.hateMatrix[f1][f2] > 0) {
                    GameState.hateMatrix[f1][f2] -= 10; 
                    if(GameState.hateMatrix[f1][f2] < 0) GameState.hateMatrix[f1][f2] = 0;
                }
            }
        }

        GameState.alliances.clear();
        const factions = Object.keys(FactionMaster);
        for(let i=0; i<factions.length; i++) {
            for(let j=i+1; j<factions.length; j++) {
                let f1 = factions[i], f2 = factions[j];
                let commonEnemy = null;
                for(let enemy of factions) {
                    if (enemy === f1 || enemy === f2) continue;
                    let h1 = GameState.hateMatrix[f1]?.[enemy] || 0;
                    let h2 = GameState.hateMatrix[f2]?.[enemy] || 0;
                    if (h1 > 300 && h2 > 300) { commonEnemy = enemy; break; }
                }
                if (commonEnemy) {
                    GameState.alliances.add(`${f1}-${f2}`);
                    if(GameState.month === 1 && (GameState.playerFaction === f1 || GameState.playerFaction === f2)) {
                        this.log(`<span style="color:#2980b9;">🤝 ${FactionMaster[commonEnemy].name} の脅威に対抗するため、${FactionMaster[f1].name} と ${FactionMaster[f2].name} が密約を結びました。</span>`);
                    }
                }
            }
        }

        if(typeof window.updateStatsTable === 'function' && !document.getElementById('stats-modal').classList.contains('modal-hidden')) {
            window.updateStatsTable();
        }

        updateUI(); drawMap();
    }
};
