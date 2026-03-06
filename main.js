window.rawNodes = []; window.rawEdges = []; window.graph = {}; 
window.armyMarkers = {}; window.castleMarkers = {};
let selection = { type: null, id: null };
let currentLogFilter = 'all';

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
    GameState.hateMatrix = {}; GameState.friendshipMatrix = {}; buildGraph();
    window.rawNodes.forEach(n => {
        if (n.type !== "5" && n.type !== "0") {
            let hpMult = (n.type === "1" ? 15 : (n.type === "3" ? 3 : (n.type === "4" ? 5 : 10)));
            let castleObj = {
                id: n.id, name: n.name, type: n.type, faction: "independent",
                currentKokudaka: 5000, commerce: 100, defense: 100, troops: 0, loyalty: 100,
                gold: 1000, food: 50000, siegeHP: 1000, maxSiegeHP: 1000, _flash: false
            };
            castleObj.troops = getMaxTroops(castleObj);
            castleObj.maxSiegeHP = castleObj.defense * hpMult;
            castleObj.siegeHP = castleObj.maxSiegeHP;
            GameState.castles[n.id] = castleObj;
        }
    });
    GameState.isLoaded = true; document.getElementById('scenarioLoader').disabled = false;
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
    Object.values(GameState.castles).forEach(castle => {
        const sData = scenarioData.castles[castle.name];
        if(sData) {
            castle.faction = sData.faction || "independent";
            castle.currentKokudaka = sData.kokudaka || 5000;
            castle.troops = getMaxTroops(castle);
            castle.food = castle.currentKokudaka * 10;
        }
    });
    GameState.hasStarted = true; document.getElementById('btnToggleTime').disabled = false;
    gameEngine.log(`物語の幕が開きました。`, 'system'); updateUI(); drawMap();
}

// 🌟 UI表示切り替え
window.toggleRightPanel = function() {
    const panel = document.getElementById('right-panel');
    const btn = document.getElementById('toggle-panel-btn');
    panel.classList.toggle('panel-hidden');
    btn.innerText = panel.classList.contains('panel-hidden') ? '◀' : '▶';
    setTimeout(() => map.invalidateSize(), 300);
};

window.toggleLogConsole = function() {
    document.getElementById('log-container').classList.toggle('minimized');
};

window.filterLogs = function(category, btn) {
    currentLogFilter = category;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const entries = document.querySelectorAll('.log-entry');
    entries.forEach(e => {
        if (category === 'all' || e.dataset.category === category) e.classList.remove('hidden');
        else e.classList.add('hidden');
    });
};

function buildGraph() {
    window.graph = {}; window.rawNodes.forEach(n => { window.graph[n.id] = []; });
    window.rawEdges.forEach(edge => {
        const n1 = window.rawNodes.find(n => n.id === edge.from), n2 = window.rawNodes.find(n => n.id === edge.to);
        if (n1 && n2) {
            const distKm = map.distance(L.latLng(n1.lat, n1.lng), L.latLng(n2.lat, n2.lng)) / 1000;
            const multiplier = EdgeMultipliers[edge.type] || 1.0;
            window.graph[n1.id].push({ to: n2.id, cost: distKm / multiplier, dist: distKm, speedMod: multiplier });
            window.graph[n2.id].push({ to: n1.id, cost: distKm / multiplier, dist: distKm, speedMod: multiplier });
        }
    });
}

function findShortestPath(startId, endId) {
    let distances = {}, prev = {}, pq = [];
    window.rawNodes.forEach(n => { distances[n.id] = Infinity; prev[n.id] = null; });
    distances[startId] = 0; pq.push({ id: startId, cost: 0 });
    while (pq.length > 0) {
        pq.sort((a, b) => a.cost - b.cost); let curr = pq.shift();
        if (curr.id === endId) break; if (curr.cost > distances[curr.id]) continue;
        window.graph[curr.id].forEach(neighbor => {
            let alt = distances[curr.id] + neighbor.cost;
            if (alt < distances[neighbor.to]) { distances[neighbor.to] = alt; prev[neighbor.to] = { id: curr.id, dist: neighbor.dist, speedMod: neighbor.speedMod }; pq.push({ id: neighbor.to, cost: alt }); }
        });
    }
    if (distances[endId] === Infinity) return null;
    let path = [], curr = endId;
    while (curr !== startId) { let p = prev[curr]; path.unshift({ nodeId: curr, dist: p.dist, speedMod: p.speedMod }); curr = p.id; }
    return path;
}

function getClosestNode(latlng) {
    let minD = Infinity, closest = null;
    window.rawNodes.forEach(n => { let d = map.distance(latlng, L.latLng(n.lat, n.lng)); if (d < minD) { minD = d; closest = n; } });
    return closest;
}

map.on('click', () => { selection = { type: null, id: null }; updateUI(); drawMap(); });
map.on('contextmenu', (e) => {
    e.originalEvent.preventDefault(); if (selection.type !== 'army') return;
    const army = GameState.armies.find(a => a.id === selection.id);
    if (!army || army.faction !== GameState.playerFaction) return;
    const closest = getClosestNode(e.latlng);
    const dist = map.distance(e.latlng, L.latLng(closest.lat, closest.lng));
    if (dist < 3000 && closest.type !== "5" && closest.type !== "0") {
        army.pathQueue = findShortestPath(getClosestNode(army.pos).id, closest.id) || [];
        army.targetNodeId = closest.id; army.task = 'attack';
        gameEngine.log(`目標を ${GameState.castles[closest.id].name} に設定。`, 'system');
    } else {
        army.targetLatLng = { lat: e.latlng.lat, lng: e.latlng.lng }; army.task = 'hold';
        gameEngine.log(`街道での待機を命じました。`, 'system');
    }
    updateUI(); drawMap();
});

window.handleNodeLeftClick = function(id, e) { L.DomEvent.stopPropagation(e); selection = { type: 'castle', id: id }; updateUI(); drawMap(); };
window.handleArmyClick = function(id, e) { L.DomEvent.stopPropagation(e); selection = { type: 'army', id: id }; updateUI(); drawMap(); };

window.updateSurvivalDays = function() {
    if(selection.type !== 'castle') return;
    const t = parseInt(document.getElementById('deploy-amount').value), f = parseInt(document.getElementById('deploy-food').value);
    document.getElementById('val-troops').innerText = t; document.getElementById('val-food').innerText = f;
    document.getElementById('val-days').innerText = t > 0 ? Math.floor(f / ((t/100) * 3.0 * GameState.priceIndex)) : "--";
};

window.deployArmy = function(cIdParam = null, amountParam = null, isAI = false, task = 'attack', aiGold=0, aiFood=0) {
    const cId = cIdParam || selection.id; const castle = GameState.castles[cId]; if (!castle) return null;
    let t = amountParam, g = aiGold, f = aiFood;
    if (!isAI) {
        t = parseInt(document.getElementById('deploy-amount').value);
        g = parseInt(document.getElementById('deploy-gold').value);
        f = parseInt(document.getElementById('deploy-food').value);
    }
    if (isNaN(t) || t <= 0 || castle.troops < t || castle.gold < g || castle.food < f) return null;
    castle.troops -= t; castle.gold -= g; castle.food -= f;
    const n = window.rawNodes.find(x => x.id === cId);
    const army = { id: "army_" + (GameState.armyIdCounter++), faction: castle.faction, troops: t, gold: g, food: f, pos: { lat: n.lat, lng: n.lng }, pathQueue: [], targetNodeId: null, targetLatLng: null, task: task };
    GameState.armies.push(army); if(!isAI) { selection = { type: 'army', id: army.id }; updateUI(); drawMap(); }
    return army;
};

function drawMap() {
    if (!GameState.isLoaded) return; nodeLayer.clearLayers(); edgeLayer.clearLayers(); armyLayer.clearLayers();
    window.rawEdges.forEach(e => {
        const n1 = window.rawNodes.find(x => x.id === e.from), n2 = window.rawNodes.find(x => x.id === e.to);
        if (n1 && n2) L.polyline([[n1.lat, n1.lng], [n2.lat, n2.lng]], { color: '#bdc3c7', weight: 2, opacity: 0.5 }).addTo(edgeLayer);
    });
    window.rawNodes.forEach(n => {
        const c = GameState.castles[n.id]; if(!c) return;
        const color = FactionMaster[c.faction]?.color || "#000";
        const shadow = (selection.id === n.id ? `box-shadow: 0 0 15px 5px ${color};` : '');
        const html = `<div style="background-color:${color}; width:100%; height:100%; border-radius:50%; ${shadow}"></div><div class="troop-badge">${c.troops}</div>`;
        L.marker([n.lat, n.lng], { icon: L.divIcon({ className: `node-marker ${c.type==='1'?'castle-main':'castle-sub'}`, html: html, iconSize:[0,0] }) }).addTo(nodeLayer).on('click', (e) => handleNodeLeftClick(n.id, e));
    });
    GameState.armies.forEach(a => {
        const isSel = (selection.id === a.id);
        const html = `<div style="position:relative;">${a.task==='transport'?'🛒':'⚔️'}<div style="position:absolute; top:-15px; left:50%; transform:translateX(-50%); font-weight:bold; font-size:10px; color:white; text-shadow:1px 1px 0 #000;">${a.troops}</div></div>`;
        const m = L.marker([a.pos.lat, a.pos.lng], { icon: L.divIcon({ className: 'army-marker'+(isSel?' army-selected':''), html: html, iconSize:[0,0] }), zIndexOffset:1000 }).addTo(armyLayer);
        m.getElement().style.backgroundColor = FactionMaster[a.faction]?.color || "#000";
        m.on('click', (e) => handleArmyClick(a.id, e));
    });
}

function updateUI() {
    if (!GameState.isLoaded || !GameState.hasStarted) return;
    document.getElementById('ui-date').innerText = `${GameState.year}年 ${GameState.month}月 ${GameState.day}日`;
    document.getElementById('ui-gold').innerText = window.getTotalGold(GameState.playerFaction);
    document.getElementById('ui-food').innerText = window.getTotalFood(GameState.playerFaction);
    updateRightPanel(); updateRanking();
}

function updateRanking() {
    const s = {}; Object.keys(FactionMaster).forEach(k => { if(k!=='independent') s[k]={id:k, castles:0, troops:0}; });
    Object.values(GameState.castles).forEach(c => { if(s[c.faction]) { s[c.faction].castles++; s[c.faction].troops+=c.troops; } });
    const list = Object.values(s).filter(x => x.castles > 0).sort((a,b) => b.castles - a.castles);
    let html = ''; list.slice(0, 5).forEach((x, i) => {
        const f = FactionMaster[x.id]; html += `<div class="rank-row"><div>${i+1}. <span class="rank-color" style="background:${f.color}"></span><b>${f.name}</b></div><div>${x.castles}城</div></div>`;
    });
    document.getElementById('ranking-content').innerHTML = html;
}

window.playAsFaction = function(id) { GameState.playerFaction = id; gameEngine.log(`${FactionMaster[id].name} で天下を目指します。`, 'system'); updateUI(); drawMap(); };

function updateRightPanel() {
    const p = document.getElementById('info-content');
    if (!selection.id) { p.innerHTML = `<p style="font-size:12px; color:#7f8c8d;">城や部隊を選択してください</p>`; return; }
    if (selection.type === 'army') {
        const a = GameState.armies.find(x => x.id === selection.id); if(!a) return;
        const f = FactionMaster[a.faction];
        p.innerHTML = `<div class="panel-section" style="border-top:4px solid ${f.color};"><b>軍勢ユニット</b><div class="data-row"><span>所属:</span> <b>${f.name}</b></div><div class="data-row"><span>兵力:</span> <b>${a.troops}</b></div><div class="data-row"><span>金/糧:</span> <b>${a.gold}/${a.food}</b></div></div>` + (a.faction===GameState.playerFaction ? `<button class="action-btn" onclick="disbandArmy('${a.id}')" style="background:#95a5a6;">部隊解散</button>` : '');
    } else {
        const c = GameState.castles[selection.id]; if(!c) return;
        const f = FactionMaster[c.faction];
        const n = window.rawNodes.find(x => x.id === c.id);
        const isSiege = GameState.armies.some(a => a.troops > 0 && !window.areAllies(a.faction, c.faction) && map.distance(L.latLng(a.pos), L.latLng(n.lat, n.lng)) < 200);
        let dT = Math.floor(c.troops*0.5), dG = Math.floor(c.gold*0.1), dF = Math.floor(c.food*0.5);
        let deployUI = c.faction===GameState.playerFaction ? `<div class="panel-section" style="background:#fdf2e9;"><b>編成</b>兵力: <span id="val-troops">${dT}</span><input type="range" id="deploy-amount" value="${dT}" max="${c.troops}" oninput="updateSurvivalDays()">兵糧: <span id="val-food">${dF}</span><input type="range" id="deploy-food" value="${dF}" max="${c.food}" oninput="updateSurvivalDays()"><input type="hidden" id="deploy-gold" value="${dG}"><div style="font-size:11px; color:#d35400;">生存予測: <span id="val-days">--</span>日</div><button class="action-btn" onclick="deployArmy()">出撃</button></div>` : '';
        let domesticUI = (c.faction===GameState.playerFaction && !isSiege) ? `<div class="panel-section"><b>内政</b><button class="cmd-btn action-btn" onclick="executeCommand('agriculture')">開墾</button><button class="cmd-btn action-btn" onclick="executeCommand('commerce')">商い</button></div>` : (isSiege ? `<div style="color:red; font-size:11px; padding:10px;">⚠️ 包囲中につき内政不可</div>` : '');
        p.innerHTML = `<div class="panel-section" style="border-top:4px solid ${f.color};"><b>${c.name}</b><div class="data-row"><span>支配:</span> <b>${f.name}</b></div><div class="data-row"><span>金/糧:</span> <b>${c.gold}/${c.food}</b></div><div class="data-row"><span>石高:</span> <b>${c.currentKokudaka}</b></div></div>` + (c.faction==='independent' && !GameState.playerFaction ? `<button class="action-btn" onclick="playAsFaction('${c.faction}')">この大名で開始</button>` : deployUI + domesticUI);
    }
}

window.updateDynamicVisuals = function() {
    Object.keys(window.armyMarkers).forEach(id => { if(!GameState.armies.find(a=>a.id===id)) { armyLayer.removeLayer(window.armyMarkers[id]); delete window.armyMarkers[id]; } });
    GameState.armies.forEach(a => {
        const m = window.armyMarkers[a.id]; if(m) { m.setLatLng([a.pos.lat, a.pos.lng]); m.getElement().querySelector('div > div').innerText = a.troops; } else drawMap();
    });
    Object.values(GameState.castles).forEach(c => { const m = window.castleMarkers[c.id]; if(m) m.getElement().querySelector('.troop-badge').innerText = c.troops; });
};
window.updateSpeedDisplay = function() { document.getElementById('speedDisplay').innerText = (document.getElementById('speedSlider').value/1000).toFixed(2)+"秒"; };
window.toggleStatsModal = function() { document.getElementById('stats-modal').classList.toggle('modal-hidden'); buildStatsTable(); };
function buildStatsTable() {
    let h = `<table style="width:100%; border-collapse:collapse; font-size:12px;"><thead><tr style="background:#34495e; color:white;"><th>大名</th><th>石高</th><th>兵力</th><th>外交</th></tr></thead><tbody>`;
    Object.keys(FactionMaster).forEach(fId => {
        if(fId==='independent') return;
        const f = FactionMaster[fId]; let k = 0, t = 0;
        Object.values(GameState.castles).forEach(c => { if(c.faction===fId) { k+=c.currentKokudaka; t+=c.troops; } });
        if(k > 0) h += `<tr style="border-bottom:1px solid #ccc;"><td>${f.name}</td><td>${k}</td><td>${t}</td><td>-</td></tr>`;
    });
    document.getElementById('stats-table-container').innerHTML = h + `</tbody></table>`;
}
