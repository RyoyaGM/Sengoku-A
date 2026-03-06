window.rawNodes = []; window.rawEdges = []; window.graph = {}; 
window.armyMarkers = {}; window.castleMarkers = {};
let selection = { type: null, id: null };
let currentLogFilter = 'all';

const map = L.map('map', { zoomControl: false }).setView([36.0, 136.0], 5);
L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', { attribution: "地理院タイル" }).addTo(map);
const nodeLayer = L.layerGroup().addTo(map); const edgeLayer = L.layerGroup().addTo(map); const armyLayer = L.layerGroup().addTo(map);

// 🌟 UI操作: 右パネルの開閉
window.toggleRightPanel = function() {
    const panel = document.getElementById('right-panel');
    const btn = document.getElementById('toggle-panel-btn');
    panel.classList.toggle('collapsed');
    btn.classList.toggle('collapsed');
    btn.innerText = panel.classList.contains('collapsed') ? '▶' : '◀';
    setTimeout(() => map.invalidateSize(), 300);
};

// 🌟 UI操作: ログコンソールの最小化
window.toggleLogConsole = function() {
    const container = document.getElementById('log-container');
    const btn = document.getElementById('toggle-log-btn');
    container.classList.toggle('minimized');
    btn.innerText = container.classList.contains('minimized') ? '▲' : '▼';
};

// 🌟 UI操作: ログフィルタリング
window.filterLogs = function(category, btn) {
    currentLogFilter = category;
    document.querySelectorAll('.log-filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    const entries = document.querySelectorAll('.log-entry');
    entries.forEach(entry => {
        if (category === 'all' || entry.classList.contains('log-' + category)) {
            entry.style.display = 'block';
        } else {
            entry.style.display = 'none';
        }
    });
};

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
    Object.values(GameState.castles).forEach(c => {
        if(c.faction !== "independent") {
            c.gold = Math.floor(1000 * GameState.priceIndex);
            c.food = Math.floor(c.currentKokudaka * 10 * GameState.priceIndex);
        }
    });
    GameState.hasStarted = true;
    document.getElementById('btnToggleTime').disabled = false;
    gameEngine.log(`物語開始。物価指数: ${GameState.priceIndex.toFixed(2)}`, 'system');
    updateUI(); drawMap();
}

window.getTotalGold = function(fId) {
    let t = 0; if(!fId) return 0;
    Object.values(GameState.castles).forEach(c => { if(c.faction === fId) t += c.gold; });
    GameState.armies.forEach(a => { if(a.faction === fId) t += a.gold; });
    return t;
};
window.getTotalFood = function(fId) {
    let t = 0; if(!fId) return 0;
    Object.values(GameState.castles).forEach(c => { if(c.faction === fId) t += c.food; });
    GameState.armies.forEach(a => { if(a.faction === fId) t += a.food; });
    return t;
};

document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); if (GameState.hasStarted) gameEngine.toggleTime(); }
});

function buildGraph() {
    window.graph = {}; window.rawNodes.forEach(n => { window.graph[n.id] = []; });
    window.rawEdges.forEach(edge => {
        const n1 = window.rawNodes.find(n => n.id === edge.from);
        const n2 = window.rawNodes.find(n => n.id === edge.to);
        if (n1 && n2) {
            const distKm = map.distance(L.latLng(n1.lat, n1.lng), L.latLng(n2.lat, n2.lng)) / 1000;
            const multiplier = EdgeMultipliers[edge.type] || EdgeMultipliers["default"];
            window.graph[n1.id].push({ to: n2.id, cost: distKm / multiplier, dist: distKm, speedMod: multiplier });
            window.graph[n2.id].push({ to: n1.id, cost: distKm / multiplier, dist: distKm, speedMod: multiplier });
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

map.on('click', () => { selection = { type: null, id: null }; updateUI(); drawMap(); });
map.on('contextmenu', (e) => {
    e.originalEvent.preventDefault();
    if (selection.type !== 'army') return;
    const army = GameState.armies.find(a => a.id === selection.id);
    if (!army || GameState.playerFaction === null || army.faction !== GameState.playerFaction) return;
    let targetArmy = null; let minArmyDist = Infinity;
    GameState.armies.forEach(a => { if (a.id !== army.id && a.troops > 0) { let d = map.distance(e.latlng, L.latLng(a.pos.lat, a.pos.lng)); if (d < 5000 && d < minArmyDist) { minArmyDist = d; targetArmy = a; } } });
    if (targetArmy) {
        army.targetArmyId = targetArmy.id; army.targetNodeId = null; army.targetLatLng = null;
        army.task = (targetArmy.faction === army.faction) ? 'supply' : 'pursuit';
        gameEngine.log(`軍勢を目標に設定。`, 'system'); updateUI(); drawMap(); return;
    }
    const closestNode = getClosestNode(e.latlng);
    const distToNode = map.distance(e.latlng, L.latLng(closestNode.lat, closestNode.lng));
    let route = findShortestPath(getClosestNode(army.pos).id, closestNode.id) || []; 
    if (distToNode < 3000 && closestNode.type !== "5" && closestNode.type !== "0") {
        army.pathQueue = route; army.targetNodeId = closestNode.id; army.targetArmyId = null; army.targetLatLng = null; army.task = 'attack';
        gameEngine.log(`目標を [${GameState.castles[closestNode.id].name}] に設定。`, 'system');
    } else {
        army.pathQueue = route; army.targetNodeId = null; army.targetArmyId = null; army.targetLatLng = { lat: e.latlng.lat, lng: e.latlng.lng }; army.task = 'hold';
        gameEngine.log(`目標を街道待機に設定。`, 'system');
    }
    updateUI(); drawMap();
});

window.handleNodeLeftClick = function(nodeId, e) { L.DomEvent.stopPropagation(e); selection = { type: 'castle', id: nodeId }; updateUI(); drawMap(); };
window.handleArmyClick = function(armyId, e) { L.DomEvent.stopPropagation(e); selection = { type: 'army', id: armyId }; updateUI(); drawMap(); };

window.updateSurvivalDays = function() {
    if(selection.type !== 'castle') return;
    const troops = parseInt(document.getElementById('deploy-amount').value) || 0;
    const food = parseInt(document.getElementById('deploy-food').value) || 0;
    document.getElementById('val-troops').innerText = troops;
    document.getElementById('val-gold').innerText = document.getElementById('deploy-gold').value;
    document.getElementById('val-food').innerText = food;
    if (troops <= 0) document.getElementById('val-days').innerText = "--";
    else { const daily = (troops / 100) * 3.0 * GameState.priceIndex; document.getElementById('val-days').innerText = Math.floor(food / daily); }
};

window.deployArmy = function(cIdParam = null, amountParam = null, isAI = false, task = 'attack', aiGold=0, aiFood=0) {
    const cId = cIdParam || selection.id; const castle = GameState.castles[cId]; if (!castle) return null;
    let amount = amountParam; let pGold = aiGold; let pFood = aiFood;
    if (!isAI) {
        amount = parseInt(document.getElementById('deploy-amount').value);
        pGold = parseInt(document.getElementById('deploy-gold').value);
        pFood = parseInt(document.getElementById('deploy-food').value);
    }
    if (isNaN(amount) || amount <= 0 || amount > castle.troops) return null;
    if (castle.gold < pGold || castle.food < pFood) { if(!isAI) alert(`資源不足！`); return null; }
    castle.troops -= amount; castle.gold -= pGold; castle.food -= pFood;
    const nDef = window.rawNodes.find(n => n.id === cId);
    const army = {
        id: "army_" + (GameState.armyIdCounter++), faction: castle.faction, troops: amount,
        gold: pGold, food: pFood, pos: { lat: nDef.lat, lng: nDef.lng }, pathQueue: [], 
        targetNodeId: null, targetLatLng: null, targetArmyId: null, task: task
    };
    GameState.armies.push(army);
    if(!isAI) { selection = { type: 'army', id: army.id }; updateUI(); drawMap(); }
    return army;
};

window.executeCommand = function(cmd) {
    if (selection.type !== 'castle') return;
    const castle = GameState.castles[selection.id];
    const nDef = window.rawNodes.find(n => n.id === castle.id);
    if (GameState.armies.some(a => a.troops > 0 && !window.areAllies(a.faction, castle.faction) && map.distance(L.latLng(a.pos), L.latLng(nDef.lat, nDef.lng)) < 200)) {
        alert("包囲中は内政不可！"); return;
    }
    let pIdx = GameState.priceIndex;
    if (cmd === 'conscript') {
        let gC = Math.floor(100 * pIdx), fC = Math.floor(50 * pIdx);
        if (castle.gold < gC || castle.food < fC) { alert(`資源不足！`); return; }
        const maxT = getMaxTroops(castle);
        if (castle.troops >= maxT) { alert("上限です。"); return; }
        castle.gold -= gC; castle.food -= fC; castle.troops = Math.min(maxT, castle.troops + 300);
        castle.loyalty = Math.max(0, castle.loyalty - 10);
        gameEngine.log(`【徴兵】${castle.name}`, 'system'); updateUI(); drawMap(); return;
    }
    if (GameState.tasks.some(t => t.castleId === castle.id)) return;
    let base = 25, days = 30;
    if(cmd === 'repair') { base = 25; days = 15; if (castle.siegeHP >= castle.maxSiegeHP) return; }
    if(cmd === 'defense') { base = 100; days = 45; }
    let cost = Math.floor(base * pIdx);
    if (castle.gold < cost) { alert(`資金不足！`); return; }
    castle.gold -= cost; 
    GameState.tasks.push({ type: cmd, castleId: castle.id, faction: castle.faction, daysLeft: days, finishCost: cost });
    gameEngine.log(`【着工】${castle.name}`, 'system'); updateUI(); drawMap();
}

function drawMap() {
    if (!GameState.isLoaded) return;
    nodeLayer.clearLayers(); edgeLayer.clearLayers(); armyLayer.clearLayers();
    window.armyMarkers = {}; window.castleMarkers = {};
    window.rawEdges.forEach(edge => {
        const n1 = window.rawNodes.find(n => n.id === edge.from);
        const n2 = window.rawNodes.find(n => n.id === edge.to);
        if (n1 && n2) {
            let color = '#bdc3c7', weight = 3;
            if(edge.type.includes('pass')) weight = 2;
            if(edge.type.includes('river') || edge.type === 'sea') color = '#5dade2';
            L.polyline([[n1.lat, n1.lng], [n2.lat, n2.lng]], { color: color, weight: weight, opacity: 0.6 }).addTo(edgeLayer);
        }
    });
    window.rawNodes.forEach(n => {
        if (n.type === "5" || n.type === "0") return; 
        const castle = GameState.castles[n.id]; if(!castle) return;
        const fColor = FactionMaster[castle.faction]?.color || "#000";
        const shadow = (selection.type === 'castle' && selection.id === n.id) ? `box-shadow: 0 0 15px 5px ${fColor};` : '';
        const html = `<div style="background-color:${fColor}; width:100%; height:100%; border-radius:50%; ${shadow}" class="${castle._flash?'castle-flash':''}"></div>
                      <div class="node-label" style="color:${fColor==='#95a5a6'?'#2c3e50':fColor}">${castle.name}</div><div class="troop-badge">${castle.troops}</div>`;
        const marker = L.marker([n.lat, n.lng], { icon: L.divIcon({ className: `node-marker ${castle.type==='1'?'castle-main':'castle-sub'}`, html: html, iconSize:[0,0] }) }).addTo(nodeLayer);
        marker.on('click', (e) => handleNodeLeftClick(n.id, e)); window.castleMarkers[n.id] = marker; castle._flash = false; 
    });
    GameState.armies.forEach(army => {
        if (army.troops <= 0) return;
        const isSel = (selection.type === 'army' && selection.id === army.id);
        const iconSymbol = army.task === 'transport' ? '🛒' : '⚔️';
        const html = `<div style="position:relative;">${iconSymbol}<div class="army-troops-label" style="position:absolute; top:-15px; left:50%; transform:translateX(-50%); font-weight:bold; color:#1a252f; text-shadow:1px 1px 0 #fff; white-space:nowrap;">${army.troops}</div></div>`;
        const m = L.marker([army.pos.lat, army.pos.lng], { icon: L.divIcon({ className: 'army-marker'+(isSel?' army-selected':''), html: html, iconSize:[0,0] }), zIndexOffset:1000 }).addTo(armyLayer);
        m.getElement().style.backgroundColor = FactionMaster[army.faction]?.color || "#000";
        window.armyMarkers[army.id] = m; m.on('click', (e) => handleArmyClick(army.id, e));
    });
}

window.showFloatingText = function(lat, lng, text, color="#e74c3c") {
    const icon = L.divIcon({ className: 'floating-text-icon', html: `<div class="floating-text" style="color:${color};">${text}</div>`, iconSize:[0,0] });
    const m = L.marker([lat+(Math.random()-0.5)*0.05, lng+(Math.random()-0.5)*0.05], {icon: icon, zIndexOffset:2000}).addTo(map);
    setTimeout(() => { if(map.hasLayer(m)) map.removeLayer(m); }, 2000);
};

function updateUI() {
    if (!GameState.isLoaded) return;
    document.getElementById('ui-date').innerText = `${GameState.year}年 ${GameState.month}月 ${GameState.day}日`;
    document.getElementById('ui-gold').innerText = window.getTotalGold(GameState.playerFaction);
    document.getElementById('ui-food').innerText = window.getTotalFood(GameState.playerFaction);
    const p = document.getElementById('info-content');
    if (!selection.id) { p.innerHTML = `<p style="font-size:12px; color:#7f8c8d;">城や部隊を選択してください</p>`; updateRanking(); return; }
    
    if (selection.type === 'army') {
        const a = GameState.armies.find(x => x.id === selection.id); if(!a) return;
        const f = FactionMaster[a.faction]; let dN = '待機中';
        if(a.targetArmyId) dN = '追尾'; else if(a.targetLatLng) dN = '街道'; else if(a.pathQueue.length>0) dN = window.rawNodes.find(n=>n.id===a.pathQueue[a.pathQueue.length-1].nodeId)?.name || '地点';
        p.innerHTML = `<div class="panel-section" style="border-top:4px solid ${f.color};"><b>軍勢ユニット</b><div class="data-row"><span>所属:</span> <b>${f.name}</b></div><div class="data-row"><span>兵力:</span> <b>${a.troops}</b></div><div class="data-row"><span>目標:</span> <b>${dN}</b></div></div>` + (a.faction===GameState.playerFaction ? `<button class="action-btn" onclick="disbandArmy('${a.id}')">解散</button>` : '');
    } else {
        const c = GameState.castles[selection.id]; if(!c) return;
        const f = FactionMaster[c.faction];
        let dH = ''; if(c.faction===GameState.playerFaction) {
            let dT = Math.floor(c.troops*0.5), dG = Math.floor(c.gold*0.1), dF = Math.floor(c.food*0.5);
            dH = `<div class="panel-section" style="background:#fdf2e9;"><b>編成</b><br><input type="range" id="deploy-amount" value="${dT}" max="${c.troops}" oninput="updateSurvivalDays()">出陣兵: <span id="val-troops">${dT}</span><br><input type="range" id="deploy-gold" value="${dG}" max="${c.gold}" oninput="updateSurvivalDays()">持参金: <span id="val-gold">${dG}</span><br><input type="range" id="deploy-food" value="${dF}" max="${c.food}" oninput="updateSurvivalDays()">持参糧: <span id="val-food">${dF}</span><div style="font-size:11px; color:#d35400;">生存: <span id="val-days">--</span>日</div><button class="action-btn" onclick="deployArmy()">出撃</button></div>`;
        }
        p.innerHTML = `<div class="panel-section" style="border-top:4px solid ${f.color};"><b>${c.name}</b><div class="data-row"><span>支配:</span> <b>${f.name}</b></div><div class="data-row"><span>金/糧:</span> <b>${c.gold}/${c.food}</b></div><div class="data-row"><span>城壁/兵:</span> <b>${Math.ceil(c.siegeHP)}/${c.troops}</b></div></div>` + dH + (c.faction===GameState.playerFaction?`<div class="panel-section"><b>内政</b><button class="cmd-btn action-btn" onclick="executeCommand('agriculture')">開墾</button><button class="cmd-btn action-btn" onclick="executeCommand('conscript')">徴兵</button></div>`:'');
    }
    updateRanking();
}

function updateRanking() {
    const s = {}; Object.keys(FactionMaster).forEach(k => { if(k!=='independent') s[k]={id:k, castles:0, troops:0}; });
    Object.values(GameState.castles).forEach(c => { if(s[c.faction]) { s[c.faction].castles++; s[c.faction].troops+=c.troops; } });
    const list = Object.values(s).filter(x => x.castles > 0).sort((a,b) => b.castles - a.castles);
    let html = ''; list.slice(0, 5).forEach((x, i) => { const f = FactionMaster[x.id]; html += `<div class="rank-row"><div><b>${i+1}.</b> <span class="rank-color" style="background-color:${f.color};"></span>${f.name}</div><div>${x.castles}城</div></div>`; });
    document.getElementById('ranking-content').innerHTML = html;
}

window.sendGoodwill = function(tF) {
    if(GameState.playerFaction === null) return;
    let myC = Object.values(GameState.castles).filter(c => c.faction === GameState.playerFaction);
    let fundC = myC.find(c => c.gold >= 100);
    if (!fundC) return;
    fundC.gold -= 100; window.addFriendship(GameState.playerFaction, tF, 50); window.addFriendship(tF, GameState.playerFaction, 50);
    gameEngine.log(`${FactionMaster[tF].name} へ親善使者。`, 'diplomacy'); updateUI();
};

window.breakAlliance = function(tF) {
    if(!confirm(`同盟破棄しますか？`)) return;
    GameState.alliances[`${GameState.playerFaction}-${tF}`] = 0;
    window.addHate(tF, GameState.playerFaction, 1000);
    Object.keys(FactionMaster).forEach(f => { if(f!=='independent'&&f!==GameState.playerFaction) window.addHate(f, GameState.playerFaction, 200); });
    gameEngine.log(`${FactionMaster[tF].name} との同盟破棄！`, 'diplomacy'); updateUI();
};

window.updateDynamicVisuals = function() {
    Object.keys(window.armyMarkers).forEach(id => { if(!GameState.armies.find(a=>a.id===id)) { armyLayer.removeLayer(window.armyMarkers[id]); delete window.armyMarkers[id]; } });
    GameState.armies.forEach(a => { const m = window.armyMarkers[a.id]; if(m) { m.setLatLng([a.pos.lat, a.pos.lng]); m.getElement().querySelector('.army-troops-label').innerText = a.troops; } else drawMap(); });
    Object.values(GameState.castles).forEach(c => { const m = window.castleMarkers[c.id]; if(m) m.getElement().querySelector('.troop-badge').innerText = c.troops; });
};

window.updateSpeedDisplay = function() { document.getElementById('speedDisplay').innerText = (document.getElementById('speedSlider').value/1000).toFixed(2)+"秒"; };
window.toggleStatsModal = function() { document.getElementById('stats-modal').classList.toggle('modal-hidden'); buildStatsTable(); };
function buildStatsTable() {
    let h = `<table class="stats-table" style="width:100%; border-collapse:collapse; font-size:12px;"><thead><tr><th>大名</th><th>金/糧</th><th>兵力</th></tr></thead><tbody>`;
    Object.keys(FactionMaster).forEach(fId => {
        if(fId==='independent') return;
        const f = FactionMaster[fId]; const g = window.getTotalGold(fId); const l = window.getTotalFood(fId);
        let troops = 0; Object.values(GameState.castles).forEach(c => { if(c.faction===fId) troops+=c.troops; }); GameState.armies.forEach(a => { if(a.faction===fId) troops+=a.troops; });
        if(troops>0 || g>0) h += `<tr><td>${f.name}</td><td>${g}/${l}</td><td>${troops}</td></tr>`;
    });
    document.getElementById('stats-table-container').innerHTML = h + `</tbody></table>`;
}
