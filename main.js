// --- main.js の updateRightPanel 関数の一部修正 ---

    if (selection.type === 'army') {
        const a = GameState.armies.find(x => x.id === selection.id); if(!a) return;
        const f = FactionMaster[a.faction]; 
        
        // 🌟 部隊の状況を細かく判定して表示
        let dN = '待機中';
        if(a.targetArmyId) {
            dN = '軍勢を追尾/迎撃中'; 
        } else if(a.targetLatLng) {
            dN = '街道に布陣中（待機）'; 
        } else if(a.task === 'attack' && a.targetNodeId) {
            let tCastle = GameState.castles[a.targetNodeId];
            if (tCastle) {
                // 目的地に到着して経路が空なら「包囲中」
                if (a.pathQueue.length === 0) dN = `<span style="color:#e74c3c; font-weight:bold;">${tCastle.name} を包囲/攻撃中</span>`;
                else dN = `${tCastle.name} へ進軍中`;
            }
        } else if(a.task === 'retreat') {
            dN = '帰還ルート探索 / 退却中';
        } else if (a.task === 'hold') {
            // 現在地のノードを取得して、城の上にいるか街道にいるかを判定
            let currentNode = getClosestNode(a.pos);
            let cCastle = GameState.castles[currentNode.id];
            if (cCastle && map.distance(L.latLng(a.pos), L.latLng(currentNode.lat, currentNode.lng)) < 500) {
                if (cCastle.faction === a.faction) dN = `${cCastle.name} で待機中`;
                else if (window.areAllies(a.faction, cCastle.faction)) dN = `<span style="color:#27ae60; font-weight:bold;">${cCastle.name} に駐屯 / 防衛中</span>`;
                else dN = `${cCastle.name} に滞在中`;
            } else {
                 dN = '街道で待機中';
            }
        } else if(a.pathQueue.length > 0) {
            dN = window.rawNodes.find(n=>n.id===a.pathQueue[a.pathQueue.length-1].nodeId)?.name || '指定地点へ移動中';
        }

        let dailyCon = Math.floor((a.troops/100)*3*GameState.priceIndex);
        let daysLeft = dailyCon > 0 ? Math.floor(a.food / dailyCon) : "∞";
        p.innerHTML = `<div class="panel-section" style="border-top:4px solid ${f.color};"><b>軍勢ユニット${a.task==='transport'?' (輸送隊)':''}</b><div class="data-row"><span>所属:</span> <b>${f.name}</b></div><div class="data-row"><span>兵力:</span> <b>${a.troops}</b></div><div class="data-row"><span>所持金/糧:</span> <b>${a.gold} / ${a.food}</b> <span style="font-size:10px;">(残 ${daysLeft}日)</span></div><div class="data-row"><span>状態:</span> <b>${dN}</b></div></div>` + (a.faction===GameState.playerFaction ? `<button class="action-btn" onclick="disbandArmy('${a.id}')" style="background:#95a5a6;">捨陣（解散）</button>` : '');
    }
