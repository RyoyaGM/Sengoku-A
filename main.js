window.rawNodes = []; window.rawEdges = []; window.graph = {}; 
window.armyMarkers = {}; window.castleMarkers = {};
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
    GameState.castles = {}; GameState.armies = []; GameState.alliances = {}; 
    GameState.hateMatrix = {}; GameState.friendshipMatrix = {}; GameState.tasks = [];
    buildGraph();

    window.rawNodes.forEach(n => {
        if (n.type !== "5" && n.type !== "0") {
            let hpMult = 10, comMult = 1, typeName = "拠点";
            if(n.type === "1") { hpMult = 15; typeName = "本城"; }
            else if(n.type === "2") { hpMult = 10; typeName = "支城"; }
            else if(n.type === "3") { hpMult = 3; comMult = 3; typeName = "町"; }
            else if(n.type === "4") { hpMult = 5; typeName = "港"; }

            let castleObj = {
                id: n.id, name: n.name, type: n.type, nodeTypeName: typeName, faction: "independent",
                currentKokudaka: 5000, commerce: 100 * comMult, defense: 100, troops: 0, loyalty: 100,
                gold: 0, food: 0
            };
            castleObj.troops = getMaxTroops(castleObj);
            castleObj.maxSiegeHP = castleObj.defense * hpMult;
            castleObj.siegeHP = castleObj.maxSiegeHP;
            GameState.castles[n.id] = castleObj;
        }
    });

    if (window.rawNodes.length > 0) map.setView([window.rawNodes[0].lat, window.rawNodes[0].lng], 6);
    GameState.isLoaded = true;
    document.getElementById('scenarioLoader').disabled = false;
    document.getElementById('overlay-start').innerHTML = `<h2>マップ読込完了</h2><p>右上の「② シナリオデータ」を読み込んでください。</p>`;
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
    if(scenarioData.factions) FactionMaster = { ...FactionMaster, ...scenarioData.factions };

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

    let totalKoku = 0; let count = 0;
    Object.values(GameState.castles).forEach(c => { totalKoku += c.currentKokudaka; count++; });
    GameState.priceIndex = count > 0 ? (totalKoku / count) / 5000 : 1.0;
    if(GameState.priceIndex < 0.1) GameState.priceIndex = 0.1; 

    // 🌟 勢力ではなく、城ごとに初期リソースを配布
    Object.values(GameState.castles).forEach(c => {
        if(c.faction !== "independent") {
            c.gold = Math.floor(1000 * GameState.priceIndex);
            c.food = Math.floor(c.currentKokudaka * 2 * GameState.priceIndex); // 石高ベースで初期兵糧
        }
    });

    GameState.hasStarted = true;
    document.getElementById('btnToggleTime').disabled = false;
    gameEngine.log(`シナリオデータ適用（物価指数: ${GameState.priceIndex.toFixed(2)}）。プレイする大名を選んでください！`);
    updateUI(); drawMap();
}

// 🌟 全体合計の取得（UI表示用）
window.getTotalGold = function(factionId) {
    let total = 0;
    Object.values(GameState.castles).forEach(c => { if(c.faction === factionId) total += c.gold; });
    GameState.armies.forEach(a => { if(a.faction === factionId) total += a.gold; });
    return total;
};
window.getTotalFood = function(factionId) {
    let total = 0;
    Object.values(GameState.castles).forEach(c => { if(c.faction === factionId) total += c.food; });
    GameState.armies.forEach(a => { if(a.faction === factionId) total += a.food; });
    return total;
};

document.addEventListener('keydown', function(event) {
    if (event.target.tagName.toLowerCase() === 'input') return;
    if (event.code === 'Space') {
        event.preventDefault(); 
        if (GameState.hasStarted && !document.getElementById('btnToggleTime').disabled) gameEngine.toggleTime();
    }
});

function buildGraph() {
    window.graph = {}; window.rawNodes.forEach(n => { window.graph[n.id] = []; });
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
        pq.sort((a, b) => a.cost - b.cost); let current = pq.shift();
        if (current.id === endId) break; if (current.cost > distances[current.id]) continue;
        window.graph[current.id].forEach(neighbor => {
            let alt = distances[current.id] + neighbor.cost;
            if (alt < distances[neighbor.to]) { distances[neighbor.to] = alt; prev[neighbor.to] = { id: current.id, dist: neighbor.dist, speedMod: neighbor.speedMod }; pq.push({ id: neighbor.to, cost: alt }); }
        });
    }
    if (distances[endId] === Infinity) return null;
    let path = []; let curr = endId;
    while (curr !== startId) { let p = prev[curr]; path.unshift({ nodeId: curr, dist: p.dist, speedMod: p.speedMod }); curr = p.id; }
    return path;
}

function getClosestNode(latlng) {
    let minD = Infinity; let closest = null;
    window.rawNodes.forEach(n => { let d = map.distance(latlng, L.latLng(n.lat, n.lng)); if (d < minD) { minD = d; closest = n; } });
    return closest;
}

map.on('click', (e) => { selection = { type: null, id: null }; updateUI(); drawMap(); });

// 🌟 右クリック：城・座標に加えて「部隊」も目標に設定
map.on('contextmenu', (e) => {
    e.originalEvent.preventDefault();
    if (selection.type !== 'army') return;
    const army = GameState.armies.find(a => a.id === selection.id);
    if (!army || GameState.playerFaction === null || army.faction !== GameState.playerFaction) return;

    // 1. 部隊（Army）がクリック位置の近くにいるかチェック
    let targetArmy = null; let minArmyDist = Infinity;
    GameState.armies.forEach(a => {
        if (a.id !== army.id && a.troops > 0) {
            let d = map.distance(e.latlng, L.latLng(a.pos.lat, a.pos.lng));
            if (d < 5000 && d < minArmyDist) { minArmyDist = d; targetArmy = a; }
        }
    });

    if (targetArmy) {
        army.targetArmyId = targetArmy.id;
        army.targetNodeId = null; army.targetLatLng = null;
        army.task = (targetArmy.faction === army.faction) ? 'supply' : 'pursuit';
        gameEngine.log(`目標を [${FactionMaster[targetArmy.faction]?.name}の部隊] に設定（動的追尾）。`);
        updateUI(); drawMap(); return;
    }

    // 2. 従来通り、城か座標か
    const closestNode = getClosestNode(e.latlng);
    const distToNode = map.distance(e.latlng, L.latLng(closestNode.lat, closestNode.lng));
    let route = findShortestPath(getClosestNode(army.pos).id, closestNode.id) || []; 

    if (distToNode < 3000 && closestNode.type !== "5" && closestNode.type !== "0") {
        army.pathQueue = route; 
        army.targetNodeId = closestNode.id;
        army.targetArmyId = null; army.targetLatLng = null;
        army.task = 'attack';
        gameEngine.log(`目標を [${GameState.castles[closestNode.id].name}] に設定。`);
    } else {
        army.pathQueue = route;
        army.targetNodeId = null;
        army.targetArmyId = null;
        army.targetLatLng = { lat: e.latlng.lat, lng: e.latlng.lng };
        army.task = 'hold';
        gameEngine.log(`目標を街道での [駐屯・待機] に設定。`);
    }
    updateUI(); drawMap();
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

// 🌟 出陣時の生存予測日数を計算・表示
window.updateSurvivalDays = function() {
    if(selection.type !== 'castle') return;
    const castle = GameState.castles[selection.id];
    if(!castle) return;

    const troops = parseInt(document.getElementById('deploy-amount').value) || 0;
    const gold = parseInt(document.getElementById('deploy-gold').value) || 0;
    const food = parseInt(document.getElementById('deploy-food').value) || 0;
    
    document.getElementById('val-troops').innerText = troops;
    document.getElementById('val-gold').innerText = gold;
    document.getElementById('val-food').innerText = food;

    if (troops <= 0) {
        document.getElementById('val-days').innerText = "--";
    } else {
        const dailyConsume = (troops / 100) * 3 * GameState.priceIndex;
        if(dailyConsume <= 0) document.getElementById('val-days').innerText = "無限";
        else document.getElementById('val-days').innerText = Math.floor(food / dailyConsume);
    }
};

window.deployArmy = function(castleId = null, deployAmount = null, isAI = false, task = 'attack', aiGold=0, aiFood=0) {
    const cId = castleId || selection.id; const castle = GameState.castles[cId]; if (!castle) return;
    
    let amount = deployAmount; let passGold = aiGold; let passFood = aiFood;
    if (!isAI) {
        amount = parseInt(document.getElementById('deploy-amount').value);
        passGold = parseInt(document.getElementById('deploy-gold').value);
        passFood = parseInt(document.getElementById('deploy-food').value);
    }
    
    if (isNaN(amount) || amount <= 0 || amount > castle.troops) return;
    if (castle.gold < passGold || castle.food < passFood) { alert(`城の備蓄が足りません。`); return; }

    castle.troops -= amount;
    castle.gold -= passGold;
    castle.food -= passFood;

    const nodeDef = window.rawNodes.find(n => n.id === cId);
    const army = {
        id: "army_" + (GameState.armyIdCounter++), faction: castle.faction, troops: amount,
        gold: passGold, food: passFood, // 🌟 軍勢がリソースを持つ
        pos: { lat: nodeDef.lat, lng: nodeDef.lng }, pathQueue: [], 
        targetNodeId: null, targetLatLng: null, targetArmyId: null, task: task
    };
    GameState.armies.push(army);
    
    if(!isAI) { selection = { type: 'army', id: army.id }; updateUI(); drawMap(); }
    return army;
};

window.executeCommand = function(cmd) {
    if (selection.type !== 'castle') return;
    const castle = GameState.castles[selection.id];
    let pIdx = GameState.priceIndex;

    if (cmd === 'conscript') {
        let gCost = Math.floor(100 * pIdx); let fCost = Math.floor(50 * pIdx);
        if (castle.gold < gCost || castle.food < fCost) { alert(`資源不足。金${gCost}、兵糧${fCost} 必要です。`); return; }
        const maxT = getMaxTroops(castle);
        if (castle.troops >= maxT) { alert("兵力は上限です。"); return; }
        castle.gold -= gCost; castle.food -= fCost;
        castle.troops = Math.min(maxT, castle.troops + 300);
        castle.loyalty = Math.max(0, castle.loyalty - 10);
        gameEngine.log(`【徴兵】${castle.name} で徴兵を行いました。(民忠低下)`);
        updateUI(); drawMap();
        return;
    }

    if (GameState.tasks.some(t => t.castleId === castle.id)) { alert("この城は現在工事中です。"); return; }

    let baseCost = 25, days = 30;
    if(cmd === 'repair') { baseCost = 25; days = 15; if (castle.siegeHP >= castle.maxSiegeHP) { alert(`城壁は無傷です。`); return; } }
    if(cmd === 'defense') { baseCost = 100; days = 45; }

    let cost = Math.floor(baseCost * pIdx);
    if (castle.gold < cost) { alert(`着工金が足りません。(必要: ${cost})`); return; }
    
    castle.gold -= cost; 
    GameState.tasks.push({ type: cmd, castleId: castle.id, faction: castle.faction, daysLeft: days, finishCost: cost });
    gameEngine.log(`【着工】${castle.name} で工事を開始しました。(工期: ${days}日)`);
    updateUI(); drawMap();
}

function drawMap() {
    if (!GameState.isLoaded) return;
    nodeLayer.clearLayers(); edgeLayer.clearLayers(); armyLayer.clearLayers();
    window.armyMarkers = {}; window.castleMarkers = {};
    
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
                const pn = window.rawNodes.find(n => n.id === step.nodeId); if (pn) routeCoords.push([pn.lat, pn.lng]);
            });
            if(army.targetLatLng) routeCoords.push([army.targetLatLng.lat, army.targetLatLng.lng]);
            L.polyline(routeCoords, { color: '#f1c40f', weight: 4, dashArray: '6,6', opacity: 0.9 }).addTo(edgeLayer);
        }
    }

    window.rawNodes.forEach(n => {
        if (n.type === "5" || n.type === "0") return; 
        const castle = GameState.castles[n.id]; if(!castle) return;

        const isMain = (castle.type === "1");
        const sizeClass = isMain ? "castle-main" : "castle-sub";
        const fColor = FactionMaster[castle.faction]?.color || "#000";
        const isFlash = castle._flash ? "castle-flash" : "";
        const shadowStyle = (selection.type === 'castle' && selection.id === n.id) ? `box-shadow: 0 0 15px 5px ${fColor};` : '';
        
        const htmlStr = `<div style="background-color:${fColor}; width:100%; height:100%; border-radius:50%; box-sizing: border-box; ${shadowStyle}" class="${isFlash}"></div>
                         <div class="node-label" style="color:${fColor === '#95a5a6' ? '#2c3e50' : fColor}">${castle.name}</div>
                         <div class="troop-badge">${castle.troops}</div>`;
                         
        const marker = L.marker([n.lat, n.lng], { icon: L.divIcon({ className: `node-marker ${sizeClass}`, html: htmlStr, iconSize: [0, 0] }) }).addTo(nodeLayer);
        marker.on('click', (e) => handleNodeLeftClick(n.id, e));
        window.castleMarkers[n.id] = marker;
        castle._flash = false; 
    });

    GameState.armies.forEach(army => {
        if (army.troops <= 0) return;
        const isSelected = (selection.type === 'army' && selection.id === army.id);
        const factionColor = FactionMaster[army.faction]?.color || "#000";
        // 🌟 輸送隊はアイコンを変える
        const iconSymbol = army.task === 'transport' ? '🛒' : '⚔️';

        const htmlStr = `<div style="position:relative;">${iconSymbol}<div class="army-troops-label" style="position:absolute; top:-15px; left:50%; transform:translateX(-50%); font-weight:bold; color:#1a252f; text-shadow:1px 1px 0 #fff,-1px -1px 0 #fff; white-space:nowrap;">${army.troops}</div></div>`;
        const marker = L.marker([army.pos.lat, army.pos.lng], { 
            icon: L.divIcon({ className: 'army-marker' + (isSelected ? ' army-selected' : ''), html: htmlStr, iconSize: [0, 0] }), 
            zIndexOffset: 1000 
        }).addTo(armyLayer);
        
        marker.getElement().style.backgroundColor = factionColor;
        window.armyMarkers[army.id] = marker; 
        marker.on('click', (e) => handleArmyClick(army.id, e));
    });
}

window.showFloatingText = function(lat, lng, text, color="#e74c3c") {
    const rLat = lat + (Math.random() - 0.5) * 0.05;
    const rLng = lng + (Math.random() - 0.5) * 0.05;
    const icon = L.divIcon({ className: 'floating-text-icon', html: `<div class="floating-text" style="color:${color};">${text}</div>`, iconSize: [0, 0] });
    const marker = L.marker([rLat, rLng], {icon: icon, zIndexOffset: 2000}).addTo(map);
    setTimeout(() => { if(map.hasLayer(marker)) map.removeLayer(marker); }, 2000);
};

function updateUI() {
    if (!GameState.isLoaded) return;
    if (GameState.hasStarted) {
        document.getElementById('ui-date').innerText = `${GameState.year}年 ${GameState.month}月 ${GameState.day}日`;
        document.getElementById('ui-gold').innerText = window.getTotalGold(GameState.playerFaction);
        document.getElementById('ui-food').innerText = window.getTotalFood(GameState.playerFaction);
        
        let seasonStr = "🌸春", seasonClass = "season-spring";
        if(GameState.month >= 6 && GameState.month <= 8) { seasonStr = "🍉夏"; seasonClass = "season-summer"; }
        else if(GameState.month >= 9 && GameState.month <= 11) { seasonStr = "🍁秋"; seasonClass = "season-autumn"; }
        else if(GameState.month === 12 || GameState.month <= 2) { seasonStr = "⛄冬"; seasonClass = "season-winter"; }
        
        const seasonEl = document.getElementById('ui-season');
        seasonEl.innerText = seasonStr; seasonEl.className = seasonClass;
    }
    updateRightPanel(); updateRanking();
}

function updateRanking() {
    const stats = {};
    Object.keys(FactionMaster).forEach(k => { if(k !== 'independent') stats[k] = { id: k, castles: 0, troops: 0 }; });
    Object.values(GameState.castles).forEach(c => { if (stats[c.faction]) { stats[c.faction].castles++; stats[c.faction].troops += c.troops; } });
    GameState.armies.forEach(a => { if (stats[a.faction]) stats[a.faction].troops += a.troops; });
    const sortedList = Object.values(stats).filter(s => s.castles > 0).sort((a, b) => b.castles - a.castles);

    let html = '';
    sortedList.slice(0, 8).forEach((s, idx) => {
        const fac = FactionMaster[s.id];
        html += `<div class="rank-row"><div><b>${idx+1}.</b> <span class="rank-color" style="background-color:${fac.color};"></span><b>${fac.name}</b></div><div>${s.castles}城 / 兵${s.troops}</div></div>`;
    });
    document.getElementById('ranking-content').innerHTML = html || '<p style="font-size: 11px;">ランキングデータがありません</p>';
}

window.playAsFaction = function(factionId) {
    GameState.playerFaction = factionId;
    gameEngine.log(`【開始】${FactionMaster[factionId].name} を担当して天下を目指します！`); updateUI(); drawMap();
};

window.disbandArmy = function(armyId) {
    const armyIndex = GameState.armies.findIndex(a => a.id === armyId); if (armyIndex === -1) return;
    GameState.armies.splice(armyIndex, 1); selection = { type: null, id: null };
    gameEngine.log(`【解散】部隊を解散し、物資は放棄されました。`); updateDynamicVisuals(); updateUI();
};

function updateRightPanel() {
    const panel = document.getElementById('info-content');
    const guideHtml = `<div class="instruction"><b>【操作】</b> 左クリック: 選択 | 右クリック: 目標(城/軍/街道) <br> <b>【ｼｮｰﾄｶｯﾄ】</b> Spaceキー: 再生/停止</div>`;

    if (selection.type === null) { panel.innerHTML = `<p style="font-size: 12px; color: #7f8c8d;">マップ上の城や部隊をクリック</p>` + guideHtml; return; }

    if (selection.type === 'army') {
        const army = GameState.armies.find(a => a.id === selection.id); if (!army) return;
        const factionData = FactionMaster[army.faction] || {name: "不明", color: "#000"};
        let destName = '待機中';
        if (army.targetArmyId) destName = '軍勢を追尾中';
        else if (army.targetLatLng) destName = '街道に布陣中';
        else if (army.pathQueue.length > 0) {
            const lastNodeId = army.pathQueue[army.pathQueue.length - 1].nodeId;
            destName = window.rawNodes.find(n => n.id === lastNodeId)?.name || '地点';
        }
        let taskStr = army.task === 'transport' ? ' (輸送隊)' : '';
        let dailyCon = Math.floor((army.troops/100)*3*GameState.priceIndex);
        let daysLeft = dailyCon > 0 ? Math.floor(army.food / dailyCon) : "∞";

        panel.innerHTML = `
            <div class="panel-section" style="border-top: 4px solid ${factionData.color};">
                <div style="font-size: 16px; font-weight: bold; margin-bottom: 5px;">軍勢ユニット${taskStr}</div>
                <div class="data-row"><span>所属:</span> <b style="color:${factionData.color};">${factionData.name}</b></div>
                <div class="data-row"><span>護衛兵力:</span> <b>${army.troops} 人</b></div>
                <div class="data-row"><span>所持金:</span> <b style="color:#f39c12;">${army.gold}</b></div>
                <div class="data-row"><span>所持兵糧:</span> <b style="color:#27ae60;">${army.food}</b> <span style="font-size:10px;">(残 ${daysLeft}日)</span></div>
                <div class="data-row"><span>目標:</span> <b style="color:#e74c3c;">${destName}</b></div>
            </div>
            ${GameState.playerFaction !== null && army.faction === GameState.playerFaction ? `
            <div class="panel-section" style="background-color: #f9f9f9;"><button class="action-btn" onclick="disbandArmy('${army.id}')" style="background-color:#95a5a6;">⛺ 捨陣（部隊解散）</button></div>` : ''}` + guideHtml;
        return;
    }

    if (selection.type === 'castle') {
        const castle = GameState.castles[selection.id]; if (!castle) return;
        const factionData = FactionMaster[castle.faction] || {name: "不明", color: "#000"};
        const isPlayer = GameState.playerFaction !== null && castle.faction === GameState.playerFaction;
        const maxT = getMaxTroops(castle);
        let pIdx = GameState.priceIndex;
        let isTask = GameState.tasks.find(t => t.castleId === castle.id);
        let badgeHtml = isTask ? `<span class="construction-badge">🚧 工事中 (残${isTask.daysLeft}日)</span>` : '';

        // 🌟 プレイヤー用の出陣・持参リソースUI
        let deployHtml = '';
        if (isPlayer) {
            let defTroops = Math.floor(castle.troops * 0.5);
            let defFood = Math.floor(castle.food * 0.5);
            let defGold = Math.floor(castle.gold * 0.1);
            let estDays = (defTroops > 0) ? Math.floor(defFood / ((defTroops/100)*3*pIdx)) : "--";
            
            deployHtml = `
            <div class="panel-section" style="background-color: #fdf2e9;">
                <div style="font-weight: bold; margin-bottom: 5px; font-size: 13px;">⚔️ 隊の編成と持参物資</div>
                <div style="font-size:11px; margin-bottom:4px;">出陣兵: <span id="val-troops" style="font-weight:bold;">${defTroops}</span> 人</div>
                <input type="range" id="deploy-amount" value="${defTroops}" max="${castle.troops}" oninput="updateSurvivalDays()">
                
                <div style="font-size:11px; margin-top:8px; margin-bottom:4px;">持参金: <span id="val-gold" style="font-weight:bold; color:#f39c12;">${defGold}</span></div>
                <input type="range" id="deploy-gold" value="${defGold}" max="${castle.gold}" oninput="updateSurvivalDays()">
                
                <div style="font-size:11px; margin-top:8px; margin-bottom:4px;">持参兵糧: <span id="val-food" style="font-weight:bold; color:#27ae60;">${defFood}</span></div>
                <input type="range" id="deploy-food" value="${defFood}" max="${castle.food}" oninput="updateSurvivalDays()">
                
                <div style="font-size:12px; color:#d35400; font-weight:bold; margin-top:5px; text-align:right;">予測生存日数: <span id="val-days">${estDays}</span> 日</div>
                
                <div style="display:flex; gap:5px; margin-top:10px;">
                    <button class="action-btn" onclick="deployArmy(null, null, false, 'attack')" style="flex:2;">⚔️ 出撃する</button>
                    <button class="action-btn" onclick="deployArmy(null, null, false, 'transport')" style="flex:1; background-color:#27ae60;">🛒 輸送隊</button>
                </div>
            </div>`;
        }

        panel.innerHTML = `
            <div class="panel-section" style="border-top: 4px solid ${factionData.color};">
                <div style="font-size: 16px; font-weight: bold; margin-bottom: 5px;">${castle.name} ${badgeHtml}</div>
                <div class="data-row"><span>支配:</span> <b style="color:${factionData.color};">${factionData.name}</b></div>
                <div class="data-row"><span>蔵の金:</span> <b style="color:#f39c12;">${castle.gold}</b></div>
                <div class="data-row"><span>蔵の兵糧:</span> <b style="color:#27ae60;">${castle.food}</b></div>
                <div class="data-row"><span>石高 (秋の年貢):</span> <b style="color:#d35400;">${castle.currentKokudaka}</b></div>
                <div class="data-row"><span>商業 (毎月の金):</span> <b style="color:#f39c12;">${castle.commerce}</b></div>
                <div class="data-row"><span>耐久度 (城壁):</span> <b style="${castle.siegeHP===0 ? 'color:#e74c3c;' : 'color:#3498db;'}">${Math.ceil(castle.siegeHP)} / ${castle.maxSiegeHP}</b></div>
                <div class="data-row"><span>守備兵力:</span> <b>${castle.troops}</b> (上限 ${maxT})</div>
            </div>
            ${GameState.playerFaction === null && castle.faction !== "independent" ? `
            <div class="panel-section"><button class="action-btn" onclick="playAsFaction('${castle.faction}')" style="background-color: #e67e22; font-weight:bold;">🎌 この大名でプレイする</button></div>` : ''}
            ${deployHtml}
            ${isPlayer ? `
            <div class="panel-section">
                <div style="font-weight: bold; margin-bottom: 5px; font-size: 13px;">🛠️ 内政・軍事 (着工金)</div>
                <button class="cmd-btn action-btn" onclick="executeCommand('agriculture')">🌾 開墾 (金${Math.floor(25*pIdx)} / 30日)</button>
                <button class="cmd-btn action-btn" onclick="executeCommand('commerce')">💰 商い (金${Math.floor(25*pIdx)} / 30日)</button>
                <div style="display:flex; gap:5px;">
                    <button class="cmd-btn action-btn" onclick="executeCommand('repair')" style="flex:1;">🔨 修繕(金${Math.floor(25*pIdx)}/15日)</button>
                    <button class="cmd-btn action-btn" onclick="executeCommand('defense')" style="flex:1;">🏯 改修(金${Math.floor(100*pIdx)}/45日)</button>
                </div>
                <button class="cmd-btn action-btn" onclick="executeCommand('conscript')" style="background-color:#c0392b;">🗣️ 臨時徴兵 (即時：金${Math.floor(100*pIdx)}/糧${Math.floor(50*pIdx)})</button>
            </div>` : ''}` + guideHtml;
    }
}

window.updateDynamicVisuals = function() {
    let needsFullRedraw = false;
    Object.keys(window.armyMarkers).forEach(id => {
        if (!GameState.armies.find(a => a.id === id)) {
            if(armyLayer.hasLayer(window.armyMarkers[id])) armyLayer.removeLayer(window.armyMarkers[id]);
            delete window.armyMarkers[id];
        }
    });

    GameState.armies.forEach(army => {
        const marker = window.armyMarkers[army.id];
        if (marker) {
            marker.setLatLng([army.pos.lat, army.pos.lng]);
            const label = marker.getElement().querySelector('.army-troops-label');
            if(label) label.innerText = army.troops;
        } else needsFullRedraw = true; 
    });

    Object.values(GameState.castles).forEach(c => {
        const marker = window.castleMarkers[c.id];
        if(marker) {
            const troopLabel = marker.getElement().querySelector('.troop-badge');
            if(troopLabel) troopLabel.innerText = c.troops;
        }
    });
    
    if (needsFullRedraw) drawMap();
};

window.updateSpeedDisplay = function() {
    const val = document.getElementById('speedSlider').value;
    document.getElementById('speedDisplay').innerText = (val / 1000).toFixed(2) + "秒";
};

window.toggleStatsModal = function() {
    if(!GameState.hasStarted) return;
    const modal = document.getElementById('stats-modal');
    if (modal.classList.contains('modal-hidden')) {
        buildStatsTable();
        modal.classList.remove('modal-hidden');
        if (!GameState.isPaused) gameEngine.toggleTime();
    } else {
        modal.classList.add('modal-hidden');
    }
};

function buildStatsTable() {
    const stats = {};
    Object.keys(FactionMaster).forEach(k => { 
        if(k !== 'independent') stats[k] = { id: k, totalCastles: 0, mainC: 0, subC: 0, townC: 0, portC: 0, troops: 0, koku: 0 }; 
    });

    Object.values(GameState.castles).forEach(c => { 
        if (stats[c.faction]) { 
            stats[c.faction].totalCastles++; 
            if(c.type==="1") stats[c.faction].mainC++; else if(c.type==="2") stats[c.faction].subC++; else if(c.type==="3") stats[c.faction].townC++; else if(c.type==="4") stats[c.faction].portC++;
            stats[c.faction].troops += c.troops;
            stats[c.faction].koku += c.currentKokudaka;
        } 
    });
    
    GameState.armies.forEach(a => { if (stats[a.faction]) stats[a.faction].troops += a.troops; });
    const sortedList = Object.values(stats).filter(s => s.totalCastles > 0).sort((a, b) => b.koku - a.koku);

    let html = `<table class="stats-table">
        <thead><tr>
            <th>勢力名</th><th>外交関係 (和睦・同盟・盟友)</th><th>金 / 兵糧 (総計)</th><th>拠点数 (本/支/町/港)</th><th>総石高 (秋の年貢)</th><th>総兵力</th>
        </tr></thead><tbody>`;

    sortedList.forEach(s => {
        const fac = FactionMaster[s.id];
        let gold = window.getTotalGold(s.id);
        let food = window.getTotalFood(s.id);
        
        let allies = [];
        Object.keys(FactionMaster).forEach(other => {
            if(s.id !== other) {
                let level = window.getAllianceLevel(s.id, other);
                if(level === 3) allies.push(`🤝${FactionMaster[other].name}(盟友)`);
                else if(level === 2) allies.push(`🤝${FactionMaster[other].name}(同盟)`);
                else if(level === 1) allies.push(`🕊️${FactionMaster[other].name}(和睦)`);
            }
        });
        let allyStr = allies.length > 0 ? allies.join(', ') : "<span style='color:#bdc3c7;'>孤立</span>";

        html += `<tr>
            <td style="font-weight:bold;"><span class="rank-color" style="background-color:${fac.color};"></span>${fac.name}</td>
            <td style="font-size:11px;">${allyStr}</td>
            <td><b style="color:#f39c12;">${gold}</b> / <b style="color:#27ae60;">${food}</b></td>
            <td><b>${s.totalCastles}</b> <span style="font-size:10px; color:#7f8c8d;">(${s.mainC}/${s.subC}/${s.townC}/${s.portC})</span></td>
            <td style="color:#d35400;">${s.koku}</td>
            <td>${s.troops}</td>
        </tr>`;
    });
    
    html += `</tbody></table>`;
    document.getElementById('stats-table-container').innerHTML = html;
}
