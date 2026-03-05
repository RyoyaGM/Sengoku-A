// --- engine.js: 二段階攻城・AI迎撃・経済・一揆 実装版 ---

const GameState = {
    isLoaded: false, hasStarted: false, isPaused: true,
    year: 1560, month: 1, day: 1, gold: 3000, castles: {}, armies: [], armyIdCounter: 1,
    playerFaction: null, alliances: new Set(), hateMatrix: {}, factionsInfo: {}
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

        GameState.armies.forEach(army => {
            if (army.troops <= 0 || army.pathQueue.length === 0) return;

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
                    army.pathQueue = []; 
                    
                    // 🌟 迎撃ロジック（城の守備兵が攻城軍を上回っており、民忠が低すぎないなら城外へ打って出る）
                    if (castle.troops > army.troops && castle.loyalty >= 40) {
                        const sortieTroops = Math.floor(castle.troops * 0.8);
                        castle.troops -= sortieTroops;
                        const defArmy = {
                            id: "army_" + (GameState.armyIdCounter++), faction: castle.faction, troops: sortieTroops,
                            pos: { lat: node.lat, lng: node.lng }, pathQueue: [], targetNodeId: null
                        };
                        GameState.armies.push(defArmy);
                        this.log(`<span class="log-combat">🐎 <b>${castle.name}</b> の守備隊が城を打って出ました！野戦に持ち込みます！</span>`);
                        if(typeof window.updateDynamicVisuals === 'function') window.updateDynamicVisuals();
                        return; // 攻城処理はスキップして野戦へ
                    }

                    const attTraits = getFactionTraits(army.faction);
                    const defTraits = getFactionTraits(castle.faction);

                    // 🌟 二段階攻城戦
                    if (castle.siegeHP > 0) {
                        // 第一段階：城壁破壊（守備側は弓矢で反撃）
                        let counterMult = 1.0;
                        if(castle.type === "1") counterMult = 1.5; // 山城は反撃が痛い
                        else if(castle.type === "3" || castle.type === "4") counterMult = 0.5; // 町・港は反撃が弱い

                        const attrition = Math.max(1, Math.floor(army.troops * 0.01) + Math.floor(castle.troops * 0.02 * counterMult));
                        army.troops = Math.max(0, army.troops - attrition);

                        const damage = Math.floor((army.troops * 0.05 * attTraits.combat_bonus * (0.8 + Math.random() * 0.4)) / (castle.defense / 100));
                        castle.siegeHP = Math.max(0, castle.siegeHP - damage);
                        addHate(castle.faction, army.faction, 2);

                        if (GameState.day % 5 === 0 && typeof window.showFloatingText === 'function') {
                            window.showFloatingText(army.pos.lat, army.pos.lng, `-${attrition*5}`, "#e74c3c");
                        }

                        if (castle.siegeHP === 0) {
                            this.log(`<span class="log-combat">🔥 <b>${FactionMaster[army.faction].name}</b>が ${castle.name} の城門を突破！強襲フェーズへ！</span>`);
                        }
                    } else {
                        // 第二段階：強襲（白兵戦）
                        const att = army.troops * (0.8 + Math.random() * 0.4) * attTraits.combat_bonus;
                        const def = castle.troops * (0.8 + Math.random() * 0.4) * defTraits.defense_bonus * 1.2; 
                        
                        if (att > def) {
                            castle.troops = Math.floor(castle.troops * 0.6); // 守備側士気崩壊ダメージ
                            army.troops = Math.floor(army.troops * 0.9);
                            
                            if (castle.troops <= 10) {
                                castle.troops = 0;
                                addHate(castle.faction, army.faction, 500); 
                                
                                Object.keys(FactionMaster).forEach(f => {
                                    if (f !== army.faction && f !== castle.faction && f !== 'independent') {
                                        addHate(f, army.faction, 50); // 周辺国への脅威波及
                                    }
                                });

                                castle.faction = army.faction; 
                                castle._flash = true; 
                                if(typeof window.showFloatingText === 'function') {
                                    const nDef = window.rawNodes.find(n => n.id === castle.id);
                                    window.showFloatingText(nDef.lat, nDef.lng, "🎊 占領", FactionMaster[army.faction].color);
                                }
                                army.troops = Math.floor(army.troops * 0.8);
                                castle.siegeHP = Math.floor(castle.maxSiegeHP * 0.25); // 占領後は耐久25%
                                castle.loyalty = 50; // 占領直後の民忠
                                
                                this.log(`<span class="log-combat">🎊 <b>${FactionMaster[army.faction].name}</b>が守備隊を殲滅し、${castle.name} を占領しました！</span>`);
                                drawMap(); 

                                const isPlayerInvolved = GameState.playerFaction !== null && (GameState.castles[node.id].faction === GameState.playerFaction || army.faction === GameState.playerFaction);
                                if(isPlayerInvolved && !GameState.isPaused) this.toggleTime();
                            }
                        } else {
                            castle.troops = Math.floor(castle.troops * 0.9);
                            army.troops = Math.floor(army.troops * 0.8);
                        }
                    }
                }
            }
        });

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
                        
                        addHate(a1.faction, a2.faction, 10);
                        addHate(a2.faction, a1.faction, 10);
                        
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
        Object.values(GameState.castles).forEach(castle => {
            if(castle.faction === 'independent') return;
            const maxT = getMaxTroops(castle);
            const deployableTroops = Math.floor(castle.troops * 0.4);
            
            // 🌟 1. 援軍ロジック（自国が攻撃されていれば後ろから助ける）
            let needReinforce = null;
            Object.values(GameState.castles).forEach(allyC => {
                if(allyC.faction === castle.faction && allyC.id !== castle.id) {
                    let isAttacked = GameState.armies.some(a => a.faction !== castle.faction && a.targetNodeId === allyC.id);
                    if(isAttacked && allyC.troops < maxT * 0.5) needReinforce = allyC;
                }
            });

            if (needReinforce && deployableTroops > 500) {
                const route = findShortestPath(castle.id, needReinforce.id);
                if (route) {
                    const army = window.deployArmy(castle.id, deployableTroops, true);
                    if (army) {
                        army.pathQueue = route; army.targetNodeId = needReinforce.id;
                        this.log(`<span class="log-ai">🐎 ${FactionMaster[castle.faction].name} が ${needReinforce.name} 救援のため出陣！</span>`);
                    }
                    return; 
                }
            }

            // 🌟 2. AIの内政ロジック（修繕・改修・徴兵）
            if(GameState.playerFaction === null || castle.faction !== GameState.playerFaction) {
                let fInfo = GameState.factionsInfo[castle.faction];
                if(fInfo) {
                    let repCost = (castle.type==="1") ? 100 : ((castle.type==="3"||castle.type==="4") ? 20 : 50);
                    let defCost = (castle.type==="1") ? 200 : ((castle.type==="3"||castle.type==="4") ? 50 : 100);

                    // ① 修繕：耐久が減っていて金があるなら直す
                    if (castle.siegeHP < castle.maxSiegeHP && fInfo.gold >= repCost + 50) {
                        fInfo.gold -= repCost;
                        castle.siegeHP = castle.maxSiegeHP;
                    }
                    // ② 徴兵：兵が不足しており、民忠と金に余裕がある
                    else if (castle.troops < maxT * 0.5 && fInfo.gold >= 150 && castle.loyalty >= 50) {
                        fInfo.gold -= 100;
                        castle.troops = Math.min(maxT, castle.troops + 300);
                        castle.loyalty -= 10;
                    }
                    // ③ 改修：金が余りまくっているなら最大HPを上げる
                    else if (fInfo.gold >= defCost + 500) {
                        fInfo.gold -= defCost;
                        castle.defense += 20;
                        let hpMult = (castle.type==="1")? 15 : ((castle.type==="3")? 3 : ((castle.type==="4")? 5 : 10));
                        castle.maxSiegeHP = castle.defense * hpMult;
                        castle.siegeHP = castle.maxSiegeHP;
                    }
                }
            }

            // 🌟 3. 侵攻ロジック（圧倒的な兵力差がないと攻めない）
            const traits = getFactionTraits(castle.faction); 
            const threshold = maxT * traits.wait_threshold;
            const sortieProb = 0.3 * traits.aggression;

            if (castle.troops < 150 || castle.troops < threshold || Math.random() > sortieProb) return; 

            let fInfo = GameState.factionsInfo[castle.faction];
            if (!fInfo || fInfo.gold < 50) return; 

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

                const enemyStrength = targetCastle.troops + (targetCastle.siegeHP * 2); // 兵数＋耐久を強さとみなす
                // 敵の戦力を1.2倍上回らないと基本的には攻めない（無謀な突撃の防止）
                if (deployableTroops < enemyStrength * 1.2 && targetCastle.faction !== 'independent') return;

                const totalCost = route.reduce((sum, r) => sum + (r.dist / r.speedMod), 0);
                const hateBonus = (GameState.hateMatrix[castle.faction]?.[targetCastle.faction] || 0) * 10;
                const score = (10000 / (totalCost + 1)) - enemyStrength + hateBonus;
                
                if (score > bestScore) { bestScore = score; bestTarget = { id: targetCastle.id, route: route }; }
            });

            if (bestTarget) {
                const army = window.deployArmy(castle.id, deployableTroops, true);
                if (army) {
                    fInfo.gold -= 50; 
                    army.pathQueue = bestTarget.route; army.targetNodeId = bestTarget.id;
                    const tName = GameState.castles[bestTarget.id].name;
                    this.log(`<span class="log-ai">【出陣】${FactionMaster[castle.faction].name}が ${tName} へ侵攻開始！</span>`);
                }
            }
        });

        // 進軍中の部隊のターゲット再評価
        GameState.armies.forEach(army => {
            if (GameState.playerFaction !== null && army.faction === GameState.playerFaction) return;
            if (army.faction === "independent") return;
            
            let needsNewTarget = false;
            if (army.pathQueue.length === 0) needsNewTarget = true;
            else if (army.targetNodeId && (GameState.castles[army.targetNodeId]?.faction === army.faction || areAllies(army.faction, GameState.castles[army.targetNodeId]?.faction))) needsNewTarget = true;

            if (needsNewTarget) {
                let startNode = getClosestNode(army.pos);
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
        });
    },

    finalizeMonth: function() {
        GameState.month++; if (GameState.month > 12) { GameState.month = 1; GameState.year++; }
        
        const isAutumnHarvest = (GameState.month === 9); 
        let factionIncome = {};
        Object.keys(FactionMaster).forEach(f => factionIncome[f] = 0);
        
        Object.values(GameState.castles).forEach(castle => {
            // 🌟 応急修理（耐久が0になっても放置で25%までは自然に塞がる）
            if (castle.siegeHP < castle.maxSiegeHP * 0.25) {
                castle.siegeHP = Math.min(castle.maxSiegeHP * 0.25, castle.siegeHP + castle.maxSiegeHP * 0.05);
            }

            if (castle.faction === "independent") return;
            const maxTroops = getMaxTroops(castle);
            const traits = getFactionTraits(castle.faction);

            // 🌟 収入計算（民忠が低いと収入激減）
            let loyMult = Math.max(0.2, castle.loyalty / 100);
            let inc = Math.floor(castle.commerce * 0.2 * loyMult);
            if(isAutumnHarvest) inc += Math.floor(castle.currentKokudaka * 1.5 * loyMult);
            if(factionIncome[castle.faction] !== undefined) factionIncome[castle.faction] += inc;

            // 兵の自然回復（民忠50以上でのみ回復）
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

            // 🌟 一揆の発生（民忠が40未満でランダム発生）
            if (castle.loyalty < 40 && Math.random() < 0.2) {
                const ikkiTroops = 500 + Math.floor(Math.random() * 500);
                const nodeDef = window.rawNodes.find(n => n.id === castle.id);
                const ikkiArmy = {
                    id: "army_" + (GameState.armyIdCounter++), faction: "independent", troops: ikkiTroops,
                    pos: { lat: nodeDef.lat + 0.005, lng: nodeDef.lng + 0.005 }, pathQueue: [], targetNodeId: castle.id
                };
                ikkiArmy.pathQueue = window.findShortestPath(getClosestNode(ikkiArmy.pos).id, castle.id) || [];
                GameState.armies.push(ikkiArmy);
                this.log(`<span style="color:#e74c3c;">🔥 <b>${castle.name}</b> の周辺で圧政に耐えかねた農民による<b>一揆</b>が発生！</span>`);
            }
        });
        
        // 収入の加算
        Object.keys(factionIncome).forEach(f => {
            if(GameState.factionsInfo[f]) GameState.factionsInfo[f].gold += factionIncome[f];
        });

        if (GameState.playerFaction && factionIncome[GameState.playerFaction] > 0) {
            if(isAutumnHarvest) this.log(`<span style="color:#d35400;">🌾 秋の収穫！年貢として金 ${factionIncome[GameState.playerFaction]} が入りました。</span>`);
        }

        // 遺恨（ヘイト）の時間経過による風化
        for (let f1 in GameState.hateMatrix) {
            for (let f2 in GameState.hateMatrix[f1]) {
                if(GameState.hateMatrix[f1][f2] > 0) {
                    GameState.hateMatrix[f1][f2] -= 10; 
                    if(GameState.hateMatrix[f1][f2] < 0) GameState.hateMatrix[f1][f2] = 0;
                }
            }
        }

        // 共通の敵に対する同盟（反〇〇連合）の自動結成
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
