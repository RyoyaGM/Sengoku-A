// --- main.js: マップ初期化、UI操作、イベントリスナー、グラフ計算 ---

window.rawNodes = []; window.rawEdges = []; window.graph = {}; window.armyMarkers = {}; 
let selection = { type: null, id: null };

const map = L.map('map', { zoomControl: false }).setView([36.0, 136.0], 5);
L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', { attribution: "地理院タイル" }).addTo(map);
const nodeLayer = L.layerGroup().addTo(map); const edgeLayer = L.layerGroup().addTo(map); const armyLayer = L.layerGroup().addTo(map);

document.getElementById('mapLoader').addEventListener('change', function(e) {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = function(event) { loadMapData(JSON.parse(event.target.result)); };
    reader.readAsText(file);
});

function loadMapData(mapData) {
    window.rawNodes = mapData.nodes || []; window.rawEdges = mapData.edges || [];
    GameState.castles = {}; GameState.armies = [];
    buildGraph();

    window.rawNodes.forEach(n => {
        if (n.type !== "5" && n.type !== "0") {
            let castleObj = {
                id: n.id, name: n.name, type: n.type, faction: "independent",
                currentKokudaka: 5000, commerce: 100, defense: 100, troops: 0
            };
            castleObj.troops = getMaxTroops(castleObj);
            GameState.castles[n.id] = castleObj;
        }
    });

    if (window.rawNodes.length > 0) map.setView([window.rawNodes[0].lat, window.rawNodes[0].lng], 6);
    GameState.isLoaded = true;
    
    document.getElementById('scenarioLoader').disabled = false;
    document.getElementById('overlay-start').innerHTML = `<h2>マップ読込完了</h2><p>右上の「② シナリオデータ」を読み込んでください。</p>`;
    gameEngine.log("マップデータを読み込みました。シナリオデータを読み込んでください。");
    drawMap();
}

document.getElementById('scenarioLoader').addEventListener('change', function(e) {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = function(event) { loadScenarioData(JSON.parse(event.target.result)); };
    reader.readAsText(file);
});

function loadScenarioData(scenarioData) {
    document.getElementById('overlay-start').style.display = 'none';

    if(scenarioData.factions) {
        FactionMaster = { ...FactionMaster, ...scenarioData.factions };
    }

    if(scenarioData.castles) {
        Object.values(GameState.castles).forEach(castle => {
            const sData = scenarioData.castles[castle.name];
            if(sData) {
                castle.faction = sData.faction || "independent";
                castle.currentKokudaka = sData.kokudaka || 5000;
                castle.troops = getMaxTroops(castle);
            }
        });
    }

    GameState.hasStarted = true;
    // リアルタイム用のボタンを有効化
    document.getElementById('btnToggleTime').disabled = false;
    
    gameEngine.log("シナリオデータを適用しました！");
    updateUI(); drawMap();
}

function buildGraph() {
    window.graph = {};
    window.rawNodes.forEach(n => { window.graph[n.id] = []; });
    window.rawEdges.forEach(edge => {
        const n1 = window.rawNodes.find(n => n.id === edge.from);
        const n2 = window.rawNodes.find(n => n.id === edge.to);
        if (n1 && n2) {
            const distKm = map.distance(L.latLng(n1.lat, n1.lng), L.latLng(n2.lat, n2.lng)) / 1000;
            const multiplier = EdgeMultipliers[edge.type] || EdgeMultipliers["default"];
            const cost = distKm / multiplier;
            window.graph[n1.id].push({ to: n2.id, cost: cost, dist: distKm, speedMod: multiplier });
            window.graph[n2.id].push({ to: n1.id, cost: cost, dist: distKm, speedMod: multiplier });
        }
    });
}

function findShortestPath(startId, endId) {
    let distances = {}; let prev = {}; let pq = [];
    window.rawNodes.forEach(n => { distances[n.id] = Infinity; prev[n.id] = null; });
    distances[startId] = 0; pq.push({ id: startId, cost: 0 });

    while (pq.length > 0) {
        pq.sort((a, b) => a.cost - b.cost);
        let current = pq.shift();
        if (current.id === endId) break;
        if (current.cost > distances[current.id]) continue;

        window.graph[current.id].forEach(neighbor => {
            let alt = distances[current.id] + neighbor.cost;
            if (alt < distances[neighbor.to]) {
                distances[neighbor.to] = alt;
                prev[neighbor.to] = { id: current.id, dist: neighbor.dist, speedMod: neighbor.speedMod };
                pq.push({ id: neighbor.to, cost: alt });
            }
        });
    }
    if (distances[endId] === Infinity) return null;
    let path = []; let curr = endId;
    while (curr !== startId) {
        let p = prev[curr];
        path.unshift({ nodeId: curr, dist: p.dist, speedMod: p.speedMod });
        curr = p.id;
    }
    return path;
}

function getClosestNode(latlng) {
    let minD = Infinity; let closest = null;
    window.rawNodes.forEach(n => {
        let d = map.distance(latlng, L.latLng(n.lat, n.lng));
        if (d < minD) { minD = d; closest = n; }
    });
    return closest;
}

function getClosestPointOnEdges(latlng) {
    let minPt = null; let minPixelDist = Infinity; let targetEdge = null;
    const pt = map.latLngToLayerPoint(latlng);

    window.rawEdges.forEach(edge => {
        const n1 = window.rawNodes.find(n => n.id === edge.from);
        const n2 = window.rawNodes.find(n => n.id === edge.to);
        if(!n1 || !n2) return;
        const p1 = map.latLngToLayerPoint([n1.lat, n1.lng]);
        const p2 = map.latLngToLayerPoint([n2.lat, n2.lng]);
        
        const l2 = (p1.x - p2.x)**2 + (p1.y - p2.y)**2;
        let t = 0;
        if (l2 !== 0) { t = ((pt.x - p1.x) * (p2.x - p1.x) + (pt.y - p1.y) * (p2.y - p1.y)) / l2; t = Math.max(0, Math.min(1, t)); }
        const proj = L.point(p1.x + t * (p2.x - p1.x), p1.y + t * (p2.y - p1.y));
        const dist = pt.distanceTo(proj);
        
        if (dist < minPixelDist) { minPixelDist = dist; targetEdge = edge; minPt = map.layerPointToLatLng(proj); }
    });
    return { latlng: minPt, edge: targetEdge, pixelDist: minPixelDist };
}

map.on('click', (e) => {
    // リアルタイムなので、アニメーション中という縛りをなくしていつでも選択解除できるようにする
    selection = { type: null, id: null }; updateUI(); drawMap();
});

map.on('contextmenu', (e) => {
    e.originalEvent.preventDefault();
    if (selection.type !== 'army') return;
    const army = GameState.armies.find(a => a.id === selection.id);
    if (!army || army.faction !== 'player') return;

    const closestCastle = getClosestNode(e.latlng);
    const distToCastle = map.distance(e.latlng, L.latLng(closestCastle.lat, closestCastle.lng));
    
    if (closestCastle && closestCastle.type !== "5" && closestCastle.type !== "0" && distToCastle < 5000) {
        const route = findShortestPath(getClosestNode(army.pos).id, closestCastle.id);
        if(route) {
            army.pathQueue = route; army.targetNodeId = closestCastle.id;
            gameEngine.log(`目標を城 [${closestCastle.name}] に設定しました。`);
            updateUI(); drawMap(); return;
        }
    }

    const snap = getClosestPointOnEdges(e.latlng);
    if (snap && snap.edge) {
        const targetEdge = snap.edge; const targetLatLng = snap.latlng;
        const speedMod = EdgeMultipliers[targetEdge.type] || 1.0;
        
        const startNode = getClosestNode(army.pos);
        const nodeA = window.rawNodes.find(n => n.id === targetEdge.from);
        const nodeB = window.rawNodes.find(n => n.id === targetEdge.to);

        let pathA = findShortestPath(startNode.id, nodeA.id);
        let pathB = findShortestPath(startNode.id, nodeB.id);

        let costA = pathA ? pathA.reduce((sum, p) => sum + (p.dist/p.speedMod), 0) + (map.distance(L.latLng(nodeA.lat, nodeA.lng), targetLatLng)/1000 / speedMod) : Infinity;
        let costB = pathB ? pathB.reduce((sum, p) => sum + (p.dist/p.speedMod), 0) + (map.distance(L.latLng(nodeB.lat, nodeB.lng), targetLatLng)/1000 / speedMod) : Infinity;

        let bestPath = null; let finalNode = null;
        if (costA < costB && pathA) { bestPath = [...pathA]; finalNode = nodeA; }
        else if (pathB) { bestPath = [...pathB]; finalNode = nodeB; }

        if (bestPath) {
            const finalDist = map.distance(L.latLng(finalNode.lat, finalNode.lng), targetLatLng) / 1000;
            if (finalDist > 0.05) bestPath.push({ isVirtual: true, lat: targetLatLng.lat, lng: targetLatLng.lng, dist: finalDist, speedMod: speedMod });
            army.pathQueue = bestPath; army.targetNodeId = null;
            gameEngine.log(`目標を「街道の中腹」に設定しました。`);
            updateUI(); drawMap();
        }
    }
});

window.handleNodeLeftClick = function(nodeId, e) {
    L.DomEvent.stopPropagation(e);
    const node = window.rawNodes.find(n => n.id === nodeId);
    if (!node || node.type === "5" || node.type === "0") return;
    selection = { type: 'castle', id: nodeId }; updateUI(); drawMap();
};

window.handleArmyClick = function(armyId, e) {
    L.DomEvent.stopPropagation(e);
    selection = { type: 'army', id: armyId }; updateUI(); drawMap();
};

window.deployArmy = function(castleId = null, deployAmount = null, isAI = false) {
    const cId = castleId || selection.id; const castle = GameState.castles[cId]; if (!castle) return;
    const amount = deployAmount || parseInt(document.getElementById('deploy-amount').value);
    
    if (isNaN(amount) || amount <= 0 || amount > castle.troops) { if(!isAI) alert("出陣させる正しい兵数を入力してください。"); return; }
    if (!isAI && GameState.gold < 50) { alert("出陣には軍資金50が必要です。"); return; }

    if(!isAI) GameState.gold -= 50;
    castle.troops -= amount;
    const nodeDef = window.rawNodes.find(n => n.id === cId);

    const army = {
        id: "army_" + (GameState.armyIdCounter++), faction: castle.faction, troops: amount,
        pos: { lat: nodeDef.lat, lng: nodeDef.lng }, pathQueue: [], targetNodeId: null
    };
    GameState.armies.push(army);
    
    if(!isAI) {
        gameEngine.log(`【出陣】${amount}の軍勢が出撃しました。マップを<b>右クリック</b>して目標を設定してください。`);
        selection = { type: 'army', id: army.id }; updateUI(); drawMap();
    }
    return army;
};

window.executeCommand = function(cmd) {
    if (selection.type !== 'castle') return;
    const castle = GameState.castles[selection.id];
    
    if (cmd === 'agriculture') {
        if (GameState.gold < 50) { alert("軍資金が足りません"); return; }
        GameState.gold -= 50; castle.currentKokudaka += 2000; gameEngine.log(`【開墾】${castle.name} の石高が上がり、最大兵数が増加しました。`);
    } else if (cmd === 'commerce') {
        if (GameState.gold < 50) { alert("軍資金が足りません"); return; }
        GameState.gold -= 50; castle.commerce += 50; gameEngine.log(`【投資】${castle.name} に市が立ち、資金収入と最大兵数が増加しました。`);
    } else if (cmd === 'defense') {
        if (GameState.gold < 100) { alert("軍資金が足りません"); return; }
        GameState.gold -= 100; castle.defense += 20; gameEngine.log(`【改修】${castle.name} の城郭が強化され、防衛力と最大兵数が上がりました。`);
    } else if (cmd === 'conscript') {
        if (GameState.gold < 100) { alert("軍資金が足りません"); return; }
        const maxT = getMaxTroops(castle);
        if (castle.troops >= maxT) { alert("上限です。石高や城郭を強化して最大兵数を上げてください。"); return; }
        GameState.gold -= 100; castle.troops = Math.min(maxT, castle.troops + 300);
        gameEngine.log(`【徴兵】${castle.name} に兵を招集しました。`);
    }
    updateUI(); drawMap();
}

function drawMap() {
    if (!GameState.isLoaded) return;
    nodeLayer.clearLayers(); edgeLayer.clearLayers(); armyLayer.clearLayers();
    window.armyMarkers = {}; 
    
    window.rawEdges.forEach(edge => {
        const n1 = window.rawNodes.find(n => n.id === edge.from);
        const n2 = window.rawNodes.find(n => n.id === edge.to);
        if (n1 && n2) {
            let color = '#bdc3c7', weight = 3, dashArray = null;
            if(edge.type.includes('pass')) { color = '#a1887f'; dashArray = '4,4'; }
            if(edge.type.includes('river') || edge.type === 'sea') { color = '#5dade2'; }
            L.polyline([[n1.lat, n1.lng], [n2.lat, n2.lng]], { color: color, weight: weight, dashArray: dashArray, opacity: 0.6 }).addTo(edgeLayer);
        }
    });

    if (selection.type === 'army') {
        const army = GameState.armies.find(a => a.id === selection.id);
        if (army && army.pathQueue && army.pathQueue.length > 0) {
            let routeCoords = [[army.pos.lat, army.pos.lng]];
            army.pathQueue.forEach(step => {
                if(step.isVirtual) routeCoords.push([step.lat, step.lng]);
                else { const pn = window.rawNodes.find(n => n.id === step.nodeId); if (pn) routeCoords.push([pn.lat, pn.lng]); }
            });
            L.polyline(routeCoords, { color: '#f1c40f', weight: 4, dashArray: '6,6', opacity: 0.9 }).addTo(edgeLayer);
        }
    }

    window.rawNodes.forEach(n => {
        if (n.type === "5" || n.type === "0") return; 
        
        const castle = GameState.castles[n.id];
        if(!castle) return;

        const sizeClass = castle.type === "1" ? "castle-main" : "castle-sub";
        const fColor = FactionMaster[castle.faction]?.color || "#000";
        
        const htmlStr = `<div style="background-color:${fColor}; width:100%; height:100%; border-radius:50%;"></div>
                         <div class="node-label" style="color:${fColor === '#95a5a6' ? '#2c3e50' : fColor}">${castle.name}</div>
                         <div class="troop-badge">${castle.troops}</div>`;
        const marker = L.marker([n.lat, n.lng], { icon: L.divIcon({ className: `node-marker ${sizeClass}`, html: htmlStr, iconSize: [0,0] }) }).addTo(nodeLayer);
        
        if (selection.type === 'castle' && selection.id === n.id) marker.getElement().style.boxShadow = `0 0 15px 5px ${fColor}`;
        marker.on('click', (e) => handleNodeLeftClick(n.id, e));
    });

    GameState.armies.forEach(army => {
        const isSelected = (selection.type === 'army' && selection.id === army.id);
        const factionColor = FactionMaster[army.faction]?.color || "#000";

        const htmlStr = `⚔️<div style="position:absolute; top:-12px; font-weight:bold; color:#1a252f; text-shadow:1px 1px 0 #fff,-1px -1px 0 #fff; white-space:nowrap;">${army.troops}</div>`;
        const marker = L.marker([army.pos.lat, army.pos.lng], { icon: L.divIcon({ className: 'army-marker', html: htmlStr, iconSize: [0,0] }), zIndexOffset: 1000 }).addTo(armyLayer);
        marker.getElement().style.backgroundColor = factionColor;
        if(isSelected) marker.getElement().style.boxShadow = '0 0 10px 4px #f1c40f';
        
        window.armyMarkers[army.id] = marker; 
        marker.on('click', (e) => handleArmyClick(army.id, e));
    });
}

function updateUI() {
    if (!GameState.isLoaded) return;
    if (GameState.hasStarted) {
        document.getElementById('ui-date').innerText = `${GameState.year}年 ${GameState.month}月 ${GameState.day}日`;
        document.getElementById('ui-gold').innerText = GameState.gold;
    }
    updateRightPanel();
    updateRanking();
}

function updateRanking() {
    const stats = {};
    Object.keys(FactionMaster).forEach(k => { if(k !== 'independent' && k !== 'player') stats[k] = { id: k, castles: 0, troops: 0 }; });

    Object.values(GameState.castles).forEach(c => {
        if (stats[c.faction]) { stats[c.faction].castles++; stats[c.faction].troops += c.troops; }
    });
    GameState.armies.forEach(a => {
        if (stats[a.faction]) stats[a.faction].troops += a.troops;
    });

    const sortedList = Object.values(stats).filter(s => s.castles > 0).sort((a, b) => b.castles - a.castles);

    let html = '';
    sortedList.slice(0, 8).forEach((s, idx) => {
        const fac = FactionMaster[s.id];
        html += `<div class="rank-row">
                    <div><b>${idx+1}.</b> <span class="rank-color" style="background-color:${fac.color};"></span><b>${fac.name}</b></div>
                    <div>${s.castles}城 / 兵${s.troops}</div>
                 </div>`;
    });
    document.getElementById('ranking-content').innerHTML = html || '<p style="font-size: 11px;">ランキングデータがありません</p>';
}

window.raiseFlag = function() {
    if (selection.type !== 'castle') return;
    GameState.castles[selection.id].faction = "player";
    GameState.castles[selection.id].troops = getMaxTroops(GameState.castles[selection.id]); 
    gameEngine.log(`【旗揚げ】${GameState.castles[selection.id].name} にてプレイヤー軍が蜂起しました！`);
    updateUI(); drawMap();
};

window.disbandArmy = function(armyId) {
    const armyIndex = GameState.armies.findIndex(a => a.id === armyId);
    if (armyIndex === -1) return;
    GameState.armies.splice(armyIndex, 1);
    selection = { type: null, id: null };
    gameEngine.log(`【解散】部隊を解散しました。`);
    updateUI(); drawMap();
};

function updateRightPanel() {
    const panel = document.getElementById('info-content');
    const guideHtml = `<div class="instruction"><b>【操作】</b> 左クリック: 選択 | 右クリック: 軍を移動</div>`;

    if (selection.type === null) { panel.innerHTML = `<p style="font-size: 12px; color: #7f8c8d;">マップ上の城や部隊をクリックしてください。</p>` + guideHtml; return; }

    if (selection.type === 'army') {
        const army = GameState.armies.find(a => a.id === selection.id);
        if (!army) return;
        const factionData = FactionMaster[army.faction] || {name: "不明", color: "#000"};
        let destName = '待機中';
        if (army.pathQueue.length > 0) {
            const lastStep = army.pathQueue[army.pathQueue.length - 1];
            if(lastStep.isVirtual) destName = "街道上の地点";
            else destName = window.rawNodes.find(n => n.id === lastStep.nodeId)?.name || '城';
        }

        panel.innerHTML = `
            <div class="panel-section" style="border-top: 4px solid ${factionData.color};">
                <div style="font-size: 16px; font-weight: bold; margin-bottom: 5px;">軍勢ユニット</div>
                <div class="data-row"><span>所属:</span> <b style="color:${factionData.color};">${factionData.name}</b></div>
                <div class="data-row"><span>兵力:</span> <b>${army.troops} 人</b></div>
                <div class="data-row"><span>目標:</span> <b style="color:#e74c3c;">${destName}</b></div>
            </div>
            ${army.faction === "player" ? `
            <div class="panel-section" style="background-color: #f9f9f9;">
                <button class="action-btn" onclick="disbandArmy('${army.id}')" style="background-color:#95a5a6;">⛺ その場で解散</button>
            </div>` : ''}` + guideHtml;
        return;
    }

    if (selection.type === 'castle') {
        const castle = GameState.castles[selection.id];
        if (!castle) return;

        const factionData = FactionMaster[castle.faction] || {name: "不明", color: "#000"};
        const isPlayer = castle.faction === "player";
        const maxT = getMaxTroops(castle);

        panel.innerHTML = `
            <div class="panel-section" style="border-top: 4px solid ${factionData.color};">
                <div style="font-size: 16px; font-weight: bold; margin-bottom: 5px;">${castle.name}</div>
                <div class="data-row"><span>支配:</span> <b style="color:${factionData.color};">${factionData.name}</b></div>
                <div class="data-row"><span>石高 (農業):</span> <b style="color:#d35400;">${castle.currentKokudaka}</b></div>
                <div class="data-row"><span>商業 (資金):</span> <b style="color:#f39c12;">${castle.commerce}</b></div>
                <div class="data-row"><span>防御 (城壁):</span> <b style="color:#7f8c8d;">${castle.defense}</b></div>
                <div class="data-row"><span>守備兵力:</span> <b>${castle.troops} / MAX ${maxT}</b></div>
            </div>
            ${!isPlayer ? `
            <div class="panel-section"><button class="action-btn" onclick="raiseFlag()">🎌 ここで旗揚げする (操作を奪う)</button></div>
            ` : ''}
            ${isPlayer ? `
            <div class="panel-section" style="background-color: #fdf2e9;">
                <div style="font-weight: bold; margin-bottom: 5px; font-size: 13px;">⚔️ 出陣</div>
                <input type="number" id="deploy-amount" value="${Math.floor(castle.troops * 0.5)}" max="${castle.troops}">
                <button class="action-btn" onclick="deployArmy()">部隊を出撃させる (金50)</button>
            </div>
            <div class="panel-section">
                <div style="font-weight: bold; margin-bottom: 5px; font-size: 13px;">🛠️ 内政・軍事コマンド</div>
                <button class="cmd-btn action-btn" onclick="executeCommand('agriculture')">🌾 開墾 (金50) - 石高UP</button>
                <button class="cmd-btn action-btn" onclick="executeCommand('commerce')">💰 市の保護 (金50) - 商業UP</button>
                <button class="cmd-btn action-btn" onclick="executeCommand('defense')">🏯 城郭改修 (金100) - 防御UP</button>
                <button class="cmd-btn action-btn" onclick="executeCommand('conscript')">🗣️ 臨時徴兵 (金100) - 兵+300</button>
            </div>` : ''}` + guideHtml;
    }
}

// 部隊マーカーだけを少しずつ動かす関数
window.updateArmyMarkers = function() {
    let needsFullRedraw = false;
    
    GameState.armies.forEach(army => {
        if (army.troops <= 0) {
            needsFullRedraw = true; // 壊滅した部隊がいる場合は全体再描画へ
            return;
        }
        const marker = window.armyMarkers[army.id];
        if (marker) {
            marker.setLatLng([army.pos.lat, army.pos.lng]); // マーカーだけをスッと動かす
        } else {
            needsFullRedraw = true; // 新規出陣があった場合も全体再描画へ
        }
    });
    
    if (needsFullRedraw) drawMap();
};
