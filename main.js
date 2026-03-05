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
    GameState.castles = {}; GameState.armies = []; GameState.alliances = new Set(); 
    GameState.hateMatrix = {}; GameState.factionFinances = {};
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
                currentKokudaka: 5000, commerce: 100 * comMult, defense: 100, troops: 0
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
    if(scenarioData.factions) {
        FactionMaster = { ...FactionMaster, ...scenarioData.factions };
        // 全勢力に初期資金(財布)を付与
        Object.keys(FactionMaster).forEach(k => {
            if(k !== 'independent') GameState.factionFinances[k] = 3000;
        });
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
    document.getElementById('btnToggleTime').disabled = false;
    gameEngine.log("シナリオデータを適用しました。プレイする大名を選んでください！");
    updateUI(); drawMap();
}

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

map.on('click', (e) => { selection = { type: null, id: null }; updateUI(); drawMap(); });

map.on('contextmenu', (e) => {
    e.originalEvent.preventDefault();
    if (selection.type !== 'army') return;
    const army = GameState.armies.find(a => a.id === selection.id);
    if (!army || GameState.playerFaction === null || army.faction !== GameState.playerFaction) return;

    const closestCastle = getClosestNode(e.latlng);
    const distToCastle = map.distance(e.latlng, L.latLng(closestCastle.lat, closestCastle.lng));
    if (closestCastle && closestCastle.type !== "5" && closestCastle.type !== "0" && distToCastle < 5000) {
        const route = findShortestPath(getClosestNode(army.pos).id, closestCastle.id);
        if(route) { army.pathQueue = route; army.targetNodeId = closestCastle.id; gameEngine.log(`目標を [${closestCastle.name}] に設定。`); updateUI(); drawMap(); return; }
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
    
    if (isNaN(amount) || amount <= 0 || amount > castle.troops) return;
    if (!isAI && GameState.factionFinances[castle.faction] < 50) { if(!isAI) alert("出陣には軍資金50が必要です。"); return; }

    GameState.factionFinances[castle.faction] -= 50;
    castle.troops -= amount;
    const nodeDef = window.rawNodes.find(n => n.id === cId);

    const army = {
        id: "army_" + (GameState.armyIdCounter++), faction: castle.faction, troops: amount,
        pos: { lat: nodeDef.lat, lng: nodeDef.lng }, pathQueue: [], targetNodeId: null
    };
    GameState.armies.push(army);
    
    if(!isAI) { selection = { type: 'army', id: army.id }; updateUI(); drawMap(); }
    return army;
};

window.executeCommand = function(cmd) {
    if (selection.type !== 'castle') return;
    const castle = GameState.castles[selection.id];
    const fac = castle.faction;
    
    if (cmd === 'agriculture') {
        if (GameState.factionFinances[fac] < 50) return;
        GameState.factionFinances[fac] -= 50; castle.currentKokudaka += 2000; gameEngine.log(`【開墾】${castle.name} の石高が上がりました。`);
    } else if (cmd === 'commerce') {
        if (GameState.factionFinances[fac] < 50) return;
        GameState.factionFinances[fac] -= 50; castle.commerce += 50; gameEngine.log(`【投資】${castle.name} の商業が上がりました。`);
    } else if (cmd === 'defense') {
        const cost = (castle.type === "1") ? 200 : (castle.type === "2" ? 100 : 50);
        if (GameState.factionFinances[fac] < cost) { alert("資金が足りません。"); return; }
        GameState.factionFinances[fac] -= cost;
        
        let rec = castle.maxSiegeHP * 0.5;
        if(castle.type === "3" || castle.type === "4") rec = castle.maxSiegeHP; // 町と港は全回復
        castle.siegeHP = Math.min(castle.maxSiegeHP, castle.siegeHP + rec);
        gameEngine.log(`【改修】${castle.name} の耐久度を修復しました。`);
    } else if (cmd === 'conscript') {
        if (GameState.factionFinances[fac] < 100) return;
        const maxT = getMaxTroops(castle);
        if (castle.troops >= maxT) { alert("上限です。"); return; }
        GameState.factionFinances[fac] -= 100; castle.troops = Math.min(maxT, castle.troops + 300);
    }
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
            L.polyline(routeCoords, { color: '#f1c40f', weight: 4, dashArray: '6,6', opacity: 0.9 }).addTo(edgeLayer);
        }
    }

    window.rawNodes.forEach(n => {
        if (n.type === "5" || n.type === "0") return; 
        const castle = GameState.castles[n.id]; if(!castle) return;

        const isMain = (castle.type === "1");
        const iconW = isMain ? 28 : 20; 
        const iconH = isMain ? 28 : 20; 
        
        const fColor = FactionMaster[castle.faction]?.color || "#000";
        const hpPct = Math.max(0, (castle.siegeHP / castle.maxSiegeHP) * 100);
        let ringColor = hpPct > 50 ? '#2ecc71' : (hpPct > 25 ? '#f1c40f' : '#e74c3c');
        let isCritical = hpPct === 0 ? ' hp-ring-critical' : '';
        if (hpPct === 0) ringColor = '#c0392b'; // 白兵戦時は赤
        
        const isFlash = castle._flash ? "castle-flash" : "";
        const shadowStyle = (selection.type === 'castle' && selection.id === n.id) ? `box-shadow: 0 0 15px 5px ${fColor};` : '';
        
        // hp-ring を描画
        const htmlStr = `<div class="hp-ring-container${isCritical}"><div class="hp-ring" style="background: conic-gradient(${ringColor} ${Math.max(1, hpPct)}%, transparent 0);"></div></div>
                         <div style="background-color:${fColor}; width:100%; height:100%; border-radius:50%; box-sizing: border-box; ${shadowStyle}" class="${isFlash}"></div>
                         <div class="node-label" style="color:${fColor === '#95a5a6' ? '#2c3e50' : fColor}">${castle.name}</div>
                         <div class="troop-badge">${castle.troops}</div>`;
                         
        const marker = L.marker([n.lat, n.lng], { 
            icon: L.divIcon({ className: `node-marker`, html: htmlStr, iconSize: [iconW, iconH], iconAnchor: [iconW/2, iconH/2] }) 
        }).addTo(nodeLayer);
        
        marker.on('click', (e) => handleNodeLeftClick(n.id, e));
        window.castleMarkers[n.id] = marker;
        castle._flash = false; 
    });

    GameState.armies.forEach(army => {
        if (army.troops <= 0) return;
        const isSelected = (selection.type === 'army' && selection.id === army.id);
        const factionColor = FactionMaster[army.faction]?.color || "#000";
        const shadowStyle = isSelected ? `box-shadow: 0 0 10px 4px #f1c40f;` : '';

        const htmlStr = `<div style="background-color: ${factionColor}; width:100%; height:100%; border-radius:50%; display:flex; align-items:center; justify-content:center; box-sizing:border-box; border: 2px solid white; font-size:14px; ${shadowStyle}">⚔️</div>
                         <div class="army-troops-label" style="position:absolute; top:-12px; left:50%; transform:translateX(-50%); font-weight:bold; color:#1a252f; text-shadow:1px 1px 0 #fff,-1px -1px 0 #fff; white-space:nowrap;">${army.troops}</div>`;
        
        const marker = L.marker([army.pos.lat, army.pos.lng], { 
            icon: L.divIcon({ className: 'army-marker', html: htmlStr, iconSize: [24, 24], iconAnchor: [12, 12] }), zIndexOffset: 1000 
        }).addTo(armyLayer);
        
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
        // 資金はプレイヤー勢力の財布から取得
        document.getElementById('ui-gold').innerText = GameState.factionFinances[GameState.playerFaction] || 0;
        
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

// 統計モーダルの切り替え
window.toggleStatsModal = function() {
    const modal = document.getElementById('stats-modal');
    if (modal.style.display === 'none') {
        renderStatsTable();
        modal.style.display = 'flex';
        if (!GameState.isPaused) gameEngine.toggleTime(); // 開いたときは時を止める
    } else {
        modal.style.display = 'none';
    }
};

window.renderStatsTable = function() {
    const container = document.getElementById('stats-table-container');
    const stats = {};
    Object.keys(FactionMaster).forEach(k => {
        if (k !== 'independent') {
            stats[k] = { 
                id: k, name: FactionMaster[k].name, color: FactionMaster[k].color, 
                gold: GameState.factionFinances[k] || 0,
                main: 0, sub: 0, town: 0, port: 0, totalCastles: 0, koku: 0, troops: 0 
            };
        }
    });

    Object.values(GameState.castles).forEach(c => {
        if (stats[c.faction]) {
            stats[c.faction].totalCastles++;
            stats[c.faction].koku += c.currentKokudaka;
            stats[c.faction].troops += c.troops;
            if(c.type === "1") stats[c.faction].main++;
            else if(c.type === "2") stats[c.faction].sub++;
            else if(c.type === "3") stats[c.faction].town++;
            else if(c.type === "4") stats[c.faction].port++;
        }
    });

    GameState.armies.forEach(a => { if (stats[a.faction]) stats[a.faction].troops += a.troops; });
    const sortedList = Object.values(stats).filter(s => s.totalCastles > 0).sort((a, b) => b.koku - a.koku); 

    let html = `<table class="stats-table">
        <thead><tr><th>勢力</th><th>外交 (同盟・警戒)</th><th>貯蓄</th><th>拠点数 (本/支/町/港)</th><th>総石高</th><th>総兵力</th></tr></thead><tbody>`;

    sortedList.forEach(s => {
        let allies = [];
        Array.from(GameState.alliances).forEach(pair => {
            const [f1, f2] = pair.split('-');
            if (f1 === s.id) allies.push(FactionMaster[f2]?.name);
            if (f2 === s.id) allies.push(FactionMaster[f1]?.name);
        });
        const allyStr = allies.length > 0 ? allies.join(', ') : '-';

        html += `<tr>
            <td style="font-weight:bold;"><span class="rank-color" style="background-color:${s.color};"></span>${s.name}</td>
            <td style="font-size:12px; color:#2980b9;">${allyStr}</td>
            <td style="font-family:monospace; font-size:15px;">${s.gold}</td>
            <td><b>${s.totalCastles}</b> <span style="font-size:11px;color:#7f8c8d;">(${s.main}/${s.sub}/${s.town}/${s.port})</span></td>
            <td style="color:#d35400; font-weight:bold;">${s.koku}</td>
            <td>${s.troops}</td>
        </tr>`;
    });
    html += `</tbody></table>`;
    container.innerHTML = html;
};

window.playAsFaction = function(factionId) {
    GameState.playerFaction = factionId;
    gameEngine.log(`【開始】${FactionMaster[factionId].name} を担当して天下を目指します！`); updateUI(); drawMap();
};

window.disbandArmy = function(armyId) {
    const armyIndex = GameState.armies.findIndex(a => a.id === armyId); if (armyIndex === -1) return;
    GameState.armies.splice(armyIndex, 1); selection = { type: null, id: null };
    gameEngine.log(`【解散】部隊を解散しました。`); updateDynamicVisuals(); updateUI();
};

function updateRightPanel() {
    const panel = document.getElementById('info-content');
    const guideHtml = `<div class="instruction"><b>【操作】</b> 左クリック: 選択 | 右クリック: 軍移動 <br> <b>【ｼｮｰﾄｶｯﾄ】</b> Spaceキー: 再生/停止</div>`;

    if (selection.type === null) { panel.innerHTML = `<p style="font-size: 12px; color: #7f8c8d;">マップ上の城や部隊をクリック</p>` + guideHtml; return; }

    if (selection.type === 'army') {
        const army = GameState.armies.find(a => a.id === selection.id); if (!army) return;
        const factionData = FactionMaster[army.faction] || {name: "不明", color: "#000"};
        let destName = '待機中';
        if (army.pathQueue.length > 0) {
            const lastNodeId = army.pathQueue[army.pathQueue.length - 1].nodeId;
            destName = window.rawNodes.find(n => n.id === lastNodeId)?.name || '地点';
        }
        panel.innerHTML = `
            <div class="panel-section" style="border-top: 4px solid ${factionData.color};">
                <div style="font-size: 16px; font-weight: bold; margin-bottom: 5px;">軍勢ユニット</div>
                <div class="data-row"><span>所属:</span> <b style="color:${factionData.color};">${factionData.name}</b></div>
                <div class="data-row"><span>兵力:</span> <b>${army.troops} 人</b></div>
                <div class="data-row"><span>目標:</span> <b style="color:#e74c3c;">${destName}</b></div>
            </div>
            ${GameState.playerFaction !== null && army.faction === GameState.playerFaction ? `
            <div class="panel-section" style="background-color: #f9f9f9;"><button class="action-btn" onclick="disbandArmy('${army.id}')" style="background-color:#95a5a6;">⛺ その場で解散</button></div>` : ''}` + guideHtml;
        return;
    }

    if (selection.type === 'castle') {
        const castle = GameState.castles[selection.id]; if (!castle) return;
        const factionData = FactionMaster[castle.faction] || {name: "不明", color: "#000"};
        const isPlayer = GameState.playerFaction !== null && castle.faction === GameState.playerFaction;
        const maxT = getMaxTroops(castle);
        
        const defCost = (castle.type === "1") ? 200 : (castle.type === "2" ? 100 : 50);
        const defRec = (castle.type === "3" || castle.type === "4") ? "全回復" : "50%回復";

        panel.innerHTML = `
            <div class="panel-section" style="border-top: 4px solid ${factionData.color};">
                <div style="font-size: 16px; font-weight: bold; margin-bottom: 5px;">${castle.name} <span style="font-size:12px; color:#7f8c8d; font-weight:normal;">(${castle.nodeTypeName})</span></div>
                <div class="data-row"><span>支配:</span> <b style="color:${factionData.color};">${factionData.name}</b></div>
                <div class="data-row"><span>石高 (農業):</span> <b style="color:#d35400;">${castle.currentKokudaka}</b></div>
                <div class="data-row"><span>商業 (資金):</span> <b style="color:#f39c12;">${castle.commerce}</b></div>
                <div class="data-row"><span>耐久度:</span> <b style="color:#3498db;">${Math.ceil(castle.siegeHP)} / ${castle.maxSiegeHP}</b></div>
                <div class="data-row"><span>守備兵力:</span> <b>${castle.troops}</b> (上限 ${maxT})</div>
            </div>
            ${GameState.playerFaction === null && castle.faction !== "independent" ? `
            <div class="panel-section"><button class="action-btn" onclick="playAsFaction('${castle.faction}')" style="background-color: #e67e22; font-weight:bold;">🎌 この大名でプレイする</button></div>` : ''}
            ${isPlayer ? `
            <div class="panel-section" style="background-color: #fdf2e9;">
                <div style="font-weight: bold; margin-bottom: 5px; font-size: 13px;">⚔️ 出陣</div>
                <input type="number" id="deploy-amount" value="${Math.floor(castle.troops * 0.5)}" max="${castle.troops}">
                <button class="action-btn" onclick="deployArmy()">出撃 (金50)</button>
            </div>
            <div class="panel-section">
                <div style="font-weight: bold; margin-bottom: 5px; font-size: 13px;">🛠️ 内政・軍事</div>
                <button class="cmd-btn action-btn" onclick="executeCommand('agriculture')">🌾 開墾 (金50)</button>
                <button class="cmd-btn action-btn" onclick="executeCommand('commerce')">💰 市の保護 (金50)</button>
                <button class="cmd-btn action-btn" onclick="executeCommand('defense')">🏯 修復・改修 (金${defCost}/${defRec})</button>
                <button class="cmd-btn action-btn" onclick="executeCommand('conscript')">🗣️ 臨時徴兵 (金100)</button>
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
            const ring = marker.getElement().querySelector('.hp-ring');
            const container = marker.getElement().querySelector('.hp-ring-container');
            if(ring && container) {
                let pct = Math.max(0, (c.siegeHP / c.maxSiegeHP) * 100);
                let color = pct > 50 ? '#2ecc71' : (pct > 25 ? '#f1c40f' : '#e74c3c');
                if (pct === 0) { color = '#c0392b'; container.classList.add('hp-ring-critical'); } 
                else { container.classList.remove('hp-ring-critical'); }
                ring.style.background = `conic-gradient(${color} ${Math.max(1, pct)}%, transparent 0)`;
            }
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
