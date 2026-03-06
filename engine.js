// --- engine.js: 5段階警戒レベル・高度AI（迷子復旧・攻城固定）完全版 ---

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

        // 🌟 目標喪失時のハイブリッド判断（A:帰還 ＋ C:転進 ＋ 孤立突破）
        GameState.armies.forEach(a => {
            if (a.troops <= 0) return;
            if (a.targetNodeId && a.task === 'attack') {
                let targetCastle = GameState.castles[a.targetNodeId];
                
                if (targetCastle && window.areAllies(a.faction, targetCastle.faction)) {
                    let bestTarget = null; let bestDist = Infinity;

                    Object.values(GameState.castles).forEach(c => {
                        if (c.faction !== a.faction && !window.areAllies(a.faction, c.faction)) {
                            let cn = window.rawNodes.find(n => n.id === c.id);
                            let d = map.distance(L.latLng(a.pos.lat, a.pos.lng), L.latLng(cn.lat, cn.lng));
                            if (d < 15000 && d < bestDist) {
                                let enemyPower = c.troops + (c.siegeHP * 0.5);
                                if (a.troops >= enemyPower * 1.2) { 
                                    let route = window.findShortestPath(getClosestNode(a.pos).id, c.id);
                                    if (route) {
                                        let days = Math.ceil(route.reduce((sum, r) => sum + (r.dist / r.speedMod), 0) / 6.0);
                                        let reqFood = Math.floor((a.troops/100) * 3.0 * pIdx * (days + 20)); 
                                        if (a.food >= reqFood) { bestDist = d; bestTarget = { id: c.id, route: route }; }
                                    }
                                }
                            }
                        }
                    });

                    if (bestTarget) {
                        a.targetNodeId = bestTarget.id; a.pathQueue = bestTarget.route;
                        a.targetArmyId = null; a.targetLatLng = null;
                        if (a.faction === GameState.playerFaction) this.log(`<span style="color:#e67e22;">📢 目標が同盟下に入りましたが、余力があるため近隣の ${GameState.castles[bestTarget.id].name} へ転進します！</span>`);
                        return;
                    }

                    let closestSelf = null; let minDistToSelf = Infinity;
                    Object.values(GameState.castles).forEach(c => {
                        if (c.faction === a.faction) { 
                            let cn = window.rawNodes.find(n => n.id === c.id);
                            let d = map.distance(L.latLng(a.pos.lat, a.pos.lng), L.latLng(cn.lat, cn.lng));
                            if (d < minDistToSelf) { minDistToSelf = d; closestSelf = c; }
                        }
                    });

                    if (closestSelf) {
                        let route = window.findShortestPath(getClosestNode(a.pos).id, closestSelf.id);
                        if (route) {
                            let breakthroughTargetId = null; let breakthroughRoute = [];
                            for (let i = 0; i < route.length; i++) {
                                let stepNodeId = route[i].nodeId;
                                let stepCastle = GameState.castles[stepNodeId];
                                if (stepCastle && stepCastle.faction !== a.faction && !window.areAllies(a.faction, stepCastle.faction)) {
                                    breakthroughTargetId = stepNodeId; breakthroughRoute = route.slice(0, i + 1); break;
                                }
                            }

                            if (breakthroughTargetId) {
                                a.task = 'attack'; a.targetNodeId = breakthroughTargetId; a.pathQueue = breakthroughRoute;
                                a.targetArmyId = null; a.targetLatLng = null;
                                if (a.faction === GameState.playerFaction) this.log(`<span style="color:#c0392b;">🔥 退路に敵影！部隊が ${GameState.castles[breakthroughTargetId].name} への突破戦（攻撃）を決行します！</span>`);
                            } else {
                                a.task = 'retreat'; a.targetNodeId = closestSelf.id; a.pathQueue = route;
                                a.targetArmyId = null; a.targetLatLng = null;
                                if (a.faction === GameState.playerFaction) this.log(`<span style="color:#2980b9;">📢 目標が同盟下に入ったため、部隊が ${closestSelf.name} へ帰還を開始しました。</span>`);
                            }
                        } else executeDesperateAttack(a);
                    } else executeDesperateAttack(a);

                    function executeDesperateAttack(army) {
                        let nearestAny = null; let minAnyDist = Infinity;
                        Object.values(GameState.castles).forEach(c => {
                            if (c.faction !== army.faction && !window.areAllies(army.faction, c.faction)) {
                                let cn = window.rawNodes.find(n => n.id === c.id);
                                let d = map.distance(L.latLng(army.pos.lat, army.pos.lng), L.latLng(cn.lat, cn.lng));
                                if (d < minAnyDist) { minAnyDist = d; nearestAny = c; }
                            }
                        });
                        if (nearestAny) {
                            let r = window.findShortestPath(getClosestNode(army.pos).id, nearestAny.id);
                            if (r) {
                                army.task = 'attack'; army.targetNodeId = nearestAny.id; army.pathQueue = r;
                                army.targetArmyId = null; army.targetLatLng = null;
                                if (army.faction === GameState.playerFaction) gameEngine.log(`<span style="color:#8e44ad;">☠️ 退路を断たれ孤立！部隊が ${nearestAny.name} へ玉砕覚悟の突撃を開始！</span>`);
                            } else army.task = 'hold';
                        } else army.task = 'hold';
                    }
                }
            }
        });

        Object.values(GameState.castles).forEach(c => {
            if(c.faction === 'independent') return;
            c.food -= Math.floor((c.troops / 100) * 0.3 * pIdx);
            if (c.food <= 0) { c.food = 0; c.troops = Math.max(0, Math.floor(c.troops * 0.95)); }
        });

        GameState.armies.forEach(a => {
            if (a.troops <= 0) return;
            let node = getClosestNode(a.pos);
            let castleAtNode = (node && node.type !== "5" && node.type !== "0") ? GameState.castles[node.id] : null;
            let distToNode = node ? map.distance(L.latLng(a.pos.lat, a.pos.lng), L.latLng(node.lat, node.lng)) : Infinity;
            
            let isAllyTerritory = castleAtNode ? window.areAllies(a.faction, castleAtNode.faction) : false;
            let isStrictAlly = castleAtNode ? (window.getAllianceLevel(a.faction, castleAtNode.faction) > 0 && a.faction !== castleAtNode.faction) : false;
            
            let baseRate = 3.0;
            let foodConsumed = 0;

            if (distToNode < 200 && isStrictAlly && a.task !== 'retreat') {
                let dailyFoodReq = Math.floor((a.troops / 100) * 1.5 * pIdx);
                let castleMinFood = Math.floor((castleAtNode.troops / 100) * 0.3 * pIdx * 30);

                if (castleAtNode.food > castleMinFood + dailyFoodReq) {
                    let castleBurden = Math.floor(dailyFoodReq * 0.7);
                    let armyBurden = dailyFoodReq - castleBurden;
                    let cost = Math.max(1, Math.floor(castleBurden * 0.1));
                    if (a.gold >= cost) {
                        a.gold -= cost; castleAtNode.gold += cost; castleAtNode.food -= castleBurden; foodConsumed = armyBurden;
                        if (a.troops < 50000 && a.gold > 0) { a.troops += Math.floor(a.troops * 0.001); a.gold -= 1; }
                    } else foodConsumed = dailyFoodReq;
                } else foodConsumed = dailyFoodReq;
            } else {
                if (a.task === 'retreat') baseRate = isAllyTerritory ? 2.0 : 3.0;
                else if (a.task === 'hold') baseRate = isAllyTerritory ? 1.0 : 2.0;
                else baseRate = isAllyTerritory ? 3.0 : 4.0;
                if (a.task === 'attack' && !a.pathQueue.length && !a.targetLatLng && !a.targetArmyId) baseRate = 5.0;
                foodConsumed = Math.floor((a.troops / 100) * baseRate * pIdx);
            }

            a.food -= foodConsumed;
            if (a.food <= 0) {
                a.food = 0; a.troops = Math.max(0, a.troops - Math.max(1, Math.floor(a.troops * 0.05)));
                if(GameState.day % 10 === 0) window.showFloatingText(a.pos.lat, a.pos.lng, "飢餓", "#e74c3c");
            }

            let closestSelf = null; let minDistToSelf = Infinity;
            Object.values(GameState.castles).forEach(c => {
                if (c.faction === a.faction) { 
                    let cn = window.rawNodes.find(n => n.id === c.id);
                    let d = map.distance(L.latLng(a.pos.lat, a.pos.lng), L.latLng(cn.lat, cn.lng));
                    if (d < minDistToSelf) { minDistToSelf = d; closestSelf = c; }
                }
            });

            if (a.task !== 'retreat' && closestSelf) {
                let cn = window.rawNodes.find(n => n.id === closestSelf.id);
                let route = window.findShortestPath(getClosestNode(a.pos).id, cn.id);
                let daysToReturn = route ? Math.ceil(route.reduce((sum, r) => sum + (r.dist / r.speedMod), 0) / 6.0) : 0;
                let reqFood = Math.floor((a.troops / 100) * 3.0 * pIdx * (daysToReturn + 5)); 
                
                if (a.food < reqFood) {
                    a.task = 'retreat'; a.pathQueue = route || []; a.targetNodeId = closestSelf.id; 
                    a.targetArmyId = null; a.targetLatLng = null;
                    if(a.faction === GameState.playerFaction) this.log(`<span style="color:#e74c3c;">⚠️ 兵糧不足の恐れ！部隊が ${closestSelf.name} へ緊急退却を開始！</span>`);
                }
            }

            if (GameState.day % 5 === 0 && a.task !== 'retreat' && isStrictAlly && distToNode < 500) {
                let isTargeted = GameState.armies.some(otherA => {
                    if (otherA.troops <= 0 || window.areAllies(a.faction, otherA.faction)) return false;
                    return otherA.targetNodeId === node.id;
                });

                if (!isTargeted && closestSelf) {
                    let cn = window.rawNodes.find(n => n.id === closestSelf.id);
                    let route = window.findShortestPath(getClosestNode(a.pos).id, cn.id);
                    a.task = 'retreat'; a.pathQueue = route || []; a.targetNodeId = closestSelf.id;
                    a.targetArmyId = null; a.targetLatLng = null;
                    window.addFriendship(castleAtNode.faction, a.faction, 20);
                    if(a.faction === GameState.playerFaction) this.log(`<span style="color:#27ae60;">🕊️ 敵影なし（任務完了）。援軍部隊が ${closestSelf.name} へ帰還を開始。</span>`);
                }
            }
        });

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

        // 🌟 移動ロジックと「迷子復旧・攻城固定」
        GameState.armies.forEach(a => {
            if (a.troops <= 0) return;
            
            if (a.targetArmyId) {
                let ta = GameState.armies.find(x => x.id === a.targetArmyId);
                if (!ta || ta.troops <= 0) { a.targetArmyId = null; a.pathQueue = []; a.task = 'retreat'; }
                else if (GameState.day % 3 === 0) {
                    let r = window.findShortestPath(getClosestNode(a.pos).id, getClosestNode(ta.pos).id);
                    if (r) a.pathQueue = r;
                }
            }

            let currentNode = getClosestNode(a.pos);
            let distToCurrentNode = map.distance(L.latLng(a.pos), L.latLng(currentNode.lat, currentNode.lng));

            // 迷子復旧処理 (Dead-end Recovery) - 改良版
            if (a.pathQueue.length === 0 && a.targetNodeId && a.task !== 'hold') {
                let targetNode = window.rawNodes.find(n => n.id === a.targetNodeId);
                if (targetNode) {
                    let currentDist = map.distance(L.latLng(a.pos.lat, a.pos.lng), L.latLng(targetNode.lat, targetNode.lng));
                    if (currentDist > 500) { 
                        let r = window.findShortestPath(currentNode.id, a.targetNodeId);
                        if (r && r.length > 0) a.pathQueue = r;
                        else a.task = 'retreat'; 
                    }
                }
            }

            let n = a.pathQueue[0], tLat, tLng, spd = 1.0;
            if (n) { let i = window.rawNodes.find(x => x.id === n.nodeId); tLat = i.lat; tLng = i.lng; spd = n.speedMod; }
            else if (a.targetLatLng) { tLat = a.targetLatLng.lat; tLng = a.targetLatLng.lng; }
            else if (a.targetArmyId) { let ta = GameState.armies.find(x => x.id === a.targetArmyId); tLat = ta.pos.lat; tLng = ta.pos.lng; }
            else {
                // 🌟 ここから下が「城にいる部隊」と「迷子になった部隊」の仕分け
                
                // 攻城中の固定 (目標の城にいて、タスクが attack の場合)
                if (a.task === 'attack' && a.targetNodeId) {
                    let tNode = window.rawNodes.find(nx => nx.id === a.targetNodeId);
                    if (tNode && map.distance(L.latLng(a.pos), L.latLng(tNode.lat, tNode.lng)) < 500) {
                        return; // 攻城中なので移動処理はスキップして城に張り付く
                    }
                }

                // 意図的な待機(プレイヤー指定) または 駐屯中(城の上) は動かさない
                if (a.task === 'hold' && a.targetLatLng) return;
                if (a.task === 'hold' && distToCurrentNode < 500) return;

                // 上記のどれにも当てはまらない（目標を失って道端にいる）場合は強制的に「帰還」をセット
                a.task = 'retreat';
                let closestSelf = null; let minDistToSelf = Infinity;
                Object.values(GameState.castles).forEach(c => {
                    if (c.faction === a.faction) { 
                        let cn = window.rawNodes.find(nx => nx.id === c.id);
                        let d = map.distance(L.latLng(a.pos.lat, a.pos.lng), L.latLng(cn.lat, cn.lng));
                        if (d < minDistToSelf) { minDistToSelf = d; closestSelf = c; }
                    }
                });
                
                if (closestSelf) {
                    let route = window.findShortestPath(currentNode.id, closestSelf.id);
                    if (route) { a.pathQueue = route; a.targetNodeId = closestSelf.id; }
                }
                return; // 経路をセットしたので次のTickから動き出す
            }

            let speedModByTroops = Math.max(0.5, Math.min(1.2, 1.2 - (a.troops / 20000)));
            let baseSpd = 6.0;
            if (a.task === 'transport') baseSpd = 3.0; 
            else if (a.task === 'retreat') baseSpd = 7.8; 
            
            let move = baseSpd * speedModByTroops * (isWinter ? 0.5 : 1.0) * spd;
            let d = map.distance(L.latLng(a.pos.lat, a.pos.lng), L.latLng(tLat, tLng)) / 1000;
            
            if (move >= d || d < 0.5) {
                a.pos = { lat: tLat, lng: tLng };
                if (a.pathQueue.length > 0) a.pathQueue.shift();
                else if (a.targetLatLng) { a.targetLatLng = null; a.task = 'hold'; }
            } else {
                let r = d === 0 ? 0 : move / d; 
                a.pos.lat += (tLat - a.pos.lat) * r; a.pos.lng += (tLng - a.pos.lng) * r;
            }
        });

        // 合流
        for (let i = 0; i < GameState.armies.length; i++) {
            for (let j = i + 1; j < GameState.armies.length; j++) {
                let a1 = GameState.armies[i], a2 = GameState.armies[j];
                if (a1.troops <= 0 || a2.troops <= 0 || a1.faction !== a2.faction) continue;
                if (a1.task === 'retreat' || a2.task === 'retreat') continue; 

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
        GameState.armies.forEach(army => {
            if (army.troops <= 0) return;
            const node = getClosestNode(army.pos);
            if (!node || node.type === "5" || node.type === "0") return;
            const castle = GameState.castles[node.id]; if(!castle) return;

            if (map.distance(L.latLng(army.pos), L.latLng(node.lat, node.lng)) < 200) {
                // 自勢力の城なら合流して消滅
                if (castle.faction === army.faction) {
                    if (army.task === 'transport' || (army.pathQueue.length === 0 && !army.targetLatLng && !army.targetArmyId) || army.task === 'retreat') {
                        castle.troops += army.troops; castle.gold += army.gold; castle.food += army.food; army.troops = 0;
                    }
                } else if (!window.areAllies(army.faction, castle.faction)) {
                    army.pathQueue = []; army.targetLatLng = null; army.targetArmyId = null;
                    if (castle.siegeHP > 0) {
                        let dmg = Math.floor(army.troops * 0.05); castle.siegeHP -= dmg;
                        army.troops -= Math.floor(castle.troops * 0.02);
                        if(GameState.day % 5 === 0) window.showFloatingText(node.lat, node.lng, "攻城");
                    } else {
                        if (army.troops > castle.troops * 1.5) {
                            army.gold += castle.gold; army.food += castle.food;
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

        for(let i=0; i<GameState.armies.length; i++) {
            for(let j=i+1; j<GameState.armies.length; j++) {
                let a1 = GameState.armies[i], a2 = GameState.armies[j];
                if (a1.troops <= 0 || a2.troops <= 0 || window.areAllies(a1.faction, a2.faction)) continue;
                
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
                    window.addHate(a1.faction, a2.faction, 10); window.addHate(a2.faction, a1.faction, 10);
                    
                    [a1, a2].forEach(target => {
                        const nearby = getClosestNode(target.pos);
                        if (nearby && nearby.type !== "5" && nearby.type !== "0") { 
                            const castle = GameState.castles[nearby.id];
                            if (castle && window.areAllies(castle.faction, (target===a1?a2:a1).faction) && castle.faction !== target.faction) {
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

        Object.values(GameState.castles).forEach(c => {
            if(c.faction === 'independent' || (GameState.playerFaction && c.faction === GameState.playerFaction)) return;
            
            let deployTroops = Math.floor(c.troops * 0.7);
            if (deployTroops < 500) return;

            const cN = window.rawNodes.find(n => n.id === c.id);
            
            let candidates = Object.values(GameState.castles)
                .filter(t => t.faction !== c.faction && !window.areAllies(c.faction, t.faction))
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

                let totalCost = route.reduce((sum, r) => sum + (r.dist / r.speedMod), 0);
                let daysToTarget = Math.ceil(totalCost / 6.0);
                let estFood = Math.floor((deployTroops / 100) * 4.0 * pIdx * (daysToTarget * 2 + 40));
                
                if (c.food < estFood) return;

                let enemyPower = targetCastle.troops + (targetCastle.siegeHP * 0.5);
                if (deployTroops < enemyPower * 1.2 && targetCastle.faction !== 'independent') return;

                let hateBonus = (GameState.hateMatrix[c.faction]?.[targetCastle.faction] || 0) * 10;
                let score = (10000 / (cand.dist + 1)) - enemyPower + hateBonus;
                
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
            c.food = Math.min(c.food, c.currentKokudaka * 15); 
            let max = getMaxTroops(c); if(c.troops < max) c.troops += Math.floor(max * 0.05);
        });

        // 領土摩擦の計算
        Object.values(GameState.castles).forEach(c => {
            if (c.faction === 'independent') return;
            window.graph[c.id].forEach(edge => {
                let neighbor = GameState.castles[edge.to];
                if (neighbor && neighbor.faction !== 'independent' && neighbor.faction !== c.faction) {
                    if (!window.areAllies(c.faction, neighbor.faction)) {
                        window.addHate(c.faction, neighbor.faction, 2); 
                    }
                }
            });
        });

        const factions = Object.keys(FactionMaster).filter(f => f !== 'independent');

        // 5段階の警戒レベルと包囲網システム
        let factionKokudaka = {}; let totalKoku = 0;
        Object.values(GameState.castles).forEach(c => {
            if(c.faction !== 'independent') {
                factionKokudaka[c.faction] = (factionKokudaka[c.faction] || 0) + c.currentKokudaka;
                totalKoku += c.currentKokudaka;
            }
        });
        
        let targetFaction = null; let maxShare = 0; let currentLevel = 0;
        
        factions.forEach(f => {
            let share = factionKokudaka[f] / (totalKoku || 1);
            let neighborKoku = 0;
            let neighbors = new Set();
            
            Object.values(GameState.castles).forEach(c => {
                if (c.faction === f) {
                    window.graph[c.id].forEach(edge => {
                        let nc = GameState.castles[edge.to];
                        if (nc && nc.faction !== 'independent' && nc.faction !== f) neighbors.add(nc.faction);
                    });
                }
            });
            neighbors.forEach(nf => { neighborKoku += factionKokudaka[nf]; });
            
            let neighborRatio = (neighborKoku > 0) ? (factionKokudaka[f] / neighborKoku) : 0;
            if (neighborKoku === 0 && share < 0.5) neighborRatio = 0;

            let level = 0;
            if (share > 0.35) level = 5; // 天魔
            else if (share > 0.25) level = 4; // 包囲
            else if (share > 0.20 || neighborRatio > 1.2) level = 3; // 防共
            else if (share > 0.15 || neighborRatio > 1.0) level = 2; // 警戒
            else if (share > 0.10 || neighborRatio > 0.8) level = 1; // 注視

            if (level > currentLevel || (level === currentLevel && share > maxShare)) {
                currentLevel = level; targetFaction = f; maxShare = share;
            }
        });

        if (currentLevel >= 1 && targetFaction) {
            let antiFactions = [];
            factions.forEach(f => {
                if (f === targetFaction) return;
                let isNear = false;
                if (currentLevel >= 4) {
                    isNear = true; 
                } else {
                    let myCastles = Object.values(GameState.castles).filter(c => c.faction === f);
                    let targetCastles = Object.values(GameState.castles).filter(c => c.faction === targetFaction);
                    for(let mc of myCastles) {
                        let mN = window.rawNodes.find(n => n.id === mc.id);
                        for(let tc of targetCastles) {
                            let tN = window.rawNodes.find(n => n.id === tc.id);
                            if (map.distance(L.latLng(mN.lat, mN.lng), L.latLng(tN.lat, tN.lng)) < 60000) { isNear = true; break; }
                        }
                        if(isNear) break;
                    }
                }
                if (isNear) antiFactions.push(f);
            });

            if (currentLevel === 1) {
                antiFactions.forEach(f => window.addHate(f, targetFaction, 5));
            } else if (currentLevel === 2) {
                for(let i=0; i<antiFactions.length; i++) {
                    for(let j=i+1; j<antiFactions.length; j++) {
                         window.addFriendship(antiFactions[i], antiFactions[j], 10);
                    }
                }
                antiFactions.forEach(f => window.addHate(f, targetFaction, 10));
            } else if (currentLevel === 3) {
                for(let i=0; i<antiFactions.length; i++) {
                    for(let j=i+1; j<antiFactions.length; j++) {
                         if (window.getDiplomacyScore(antiFactions[i], antiFactions[j]) < 150) {
                             window.addFriendship(antiFactions[i], antiFactions[j], 30);
                         }
                    }
                }
                antiFactions.forEach(f => window.addHate(f, targetFaction, 30));
            } else if (currentLevel >= 4) {
                for(let i=0; i<antiFactions.length; i++) {
                    for(let j=i+1; j<antiFactions.length; j++) {
                         if (window.getDiplomacyScore(antiFactions[i], antiFactions[j]) < 300) {
                             window.addFriendship(antiFactions[i], antiFactions[j], 50);
                         }
                    }
                }
                antiFactions.forEach(f => window.addHate(f, targetFaction, (currentLevel === 5 ? 100 : 50)));
            }

            if (GameState.month === 1) {
                let lvlNames = ["", "注視", "警戒", "防共", "包囲", "天魔"];
                if(currentLevel >= 3) this.log(`<span style="color:#8e44ad; font-weight:bold;">🚨 諸大名が【${FactionMaster[targetFaction].name} 包囲網 (Lv${currentLevel}: ${lvlNames[currentLevel]})】を形成しています！</span>`);
                else this.log(`<span style="color:#e67e22;">⚠️ 諸大名が ${FactionMaster[targetFaction].name} の拡大を注視しています (警戒Lv${currentLevel})。</span>`);
            }
        }

        // 呉越同舟
        for(let i=0; i<factions.length; i++) {
            for(let j=i+1; j<factions.length; j++) {
                let f1 = factions[i], f2 = factions[j];
                let hasCommonThreat = false;
                for(let k=0; k<factions.length; k++) {
                    let enemy = factions[k];
                    if (enemy === f1 || enemy === f2) continue;
                    if ((GameState.hateMatrix[f1]?.[enemy] || 0) >= 200 && (GameState.hateMatrix[f2]?.[enemy] || 0) >= 200) { 
                        hasCommonThreat = true; break; 
                    }
                }
                if (hasCommonThreat) {
                    window.addFriendship(f1, f2, 15); window.addFriendship(f2, f1, 15);
                }
            }
        }

        // AIの能動的親善
        factions.forEach(f => {
            if (f === GameState.playerFaction || f === targetFaction) return;
            let myCastles = Object.values(GameState.castles).filter(c => c.faction === f);
            if(myCastles.length === 0) return;
            let richest = myCastles.reduce((a, b) => a.gold > b.gold ? a : b);
            
            if (richest.gold >= 300) {
                let neighbors = new Set();
                myCastles.forEach(mc => {
                    window.graph[mc.id].forEach(edge => {
                        let nc = GameState.castles[edge.to];
                        if(nc && nc.faction !== 'independent' && nc.faction !== f) neighbors.add(nc.faction);
                    });
                });
                neighbors.forEach(nf => {
                    if (nf === targetFaction) return;
                    let score = window.getDiplomacyScore(f, nf);
                    if (score > -50 && score < 300 && richest.gold >= 150) {
                        richest.gold -= 100;
                        window.addFriendship(f, nf, 40); window.addFriendship(nf, f, 40);
                    }
                });
            }
        });

        for (let f1 in GameState.hateMatrix) { for (let f2 in GameState.hateMatrix[f1]) { GameState.hateMatrix[f1][f2] = Math.max(0, GameState.hateMatrix[f1][f2] - 10); } }
        for (let f1 in GameState.friendshipMatrix) { for (let f2 in GameState.friendshipMatrix[f1]) { GameState.friendshipMatrix[f1][f2] = Math.max(0, GameState.friendshipMatrix[f1][f2] - 5); } }
        
        GameState.alliances = {};
        for(let i=0; i<factions.length; i++) {
            for(let j=i+1; j<factions.length; j++) {
                let f1 = factions[i], f2 = factions[j];
                let mutualScore = (window.getDiplomacyScore(f1, f2) + window.getDiplomacyScore(f2, f1)) / 2;
                let level = 0;
                if (mutualScore >= 600) level = 3;
                else if (mutualScore >= 300) level = 2;
                else if (mutualScore >= 150) level = 1;
                
                if (level > 0) GameState.alliances[`${f1}-${f2}`] = level;
            }
        }

        if(typeof window.updateStatsTable === 'function' && !document.getElementById('stats-modal').classList.contains('modal-hidden')) window.updateStatsTable();
        updateUI(); drawMap();
    }
};
