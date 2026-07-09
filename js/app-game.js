// ★ ⑤ 装备系统（轻量接入）：武器 damage_bonus 在 action-menu.resolveAttack 生效；面板展示 armor ac_bonus
// 这些辅助函数在多 <script> 共享词法全局下为全局可见，供 UI 与动作菜单调用。
function equipItem(gs, itemId) {
    if (!gs || !gs.inventory) return false;
    const item = gs.inventory.find(function(i) { return i.item_id === itemId; });
    if (!item || !item.equippable || !item.slot) return false;
    gs.equipped = gs.equipped || {};
    gs.equipped[item.slot] = itemId;
    return true;
}
function unequipItem(gs, slot) {
    if (!gs || !gs.equipped) return false;
    if (!gs.equipped[slot]) return false;
    gs.equipped[slot] = null;
    return true;
}
function getEquippedItem(gs, slot) {
    if (!gs || !gs.equipped || !gs.equipped[slot]) return null;
    return gs.inventory.find(function(i) { return i.item_id === gs.equipped[slot]; }) || null;
}
function getWeaponDamageBonus(gs) {
    const w = getEquippedItem(gs, "weapon");
    return (w && typeof w.damage_bonus === "number") ? w.damage_bonus : 0;
}
function getArmorAcBonus(gs) {
    const a = getEquippedItem(gs, "armor");
    return (a && typeof a.ac_bonus === "number") ? a.ac_bonus : 0;
}

function applyStateChanges(changes) {
    if (!changes) return;
    const s = gameState;

    // ★ S3: 引擎侧严格校验——防止 AI 幻觉输出破坏游戏状态完整性
    // 1. 死亡后禁止任何状态变更（除非是复活标记）
    if (s.is_alive === false && changes.is_alive !== true) {
        console.warn("[S3] 忽略死亡后状态变更", Object.keys(changes).slice(0, 5));
        return;
    }
    // 2. 阵营 stance 单轮跨度校验（防止 AI 一夜之间从敌视跳到崇敬）
    if (changes.factions && typeof changes.factions === "object" && !Array.isArray(changes.factions)) {
        var STANCE_ORDER = ["敌视", "冷淡", "中立", "友善", "崇敬"];
        for (var fk in changes.factions) {
            if (!changes.factions.hasOwnProperty(fk)) continue;
            var fNew = changes.factions[fk];
            if (fNew && typeof fNew.stance === "string") {
                var curStance = (s.factions[fk] && s.factions[fk].stance) || "中立";
                var curIdx = STANCE_ORDER.indexOf(curStance);
                var newIdx = STANCE_ORDER.indexOf(fNew.stance);
                if (curIdx >= 0 && newIdx >= 0 && Math.abs(newIdx - curIdx) > 2) {
                    console.warn("[S3] 阵营 stance 跨度过大，钳制", fk, curStance + "→" + fNew.stance);
                    // 钳制为最多 2 档
                    fNew.stance = STANCE_ORDER[newIdx > curIdx ? Math.min(curIdx + 2, 4) : Math.max(curIdx - 2, 0)];
                }
            }
            // 声望 delta 钳制（单轮 ±30）
            if (fNew && typeof fNew.reputation_delta === "number") {
                if (fNew.reputation_delta > 30) fNew.reputation_delta = 30;
                if (fNew.reputation_delta < -30) fNew.reputation_delta = -30;
            }
        }
    }
    // 3. 物品跨世界归属拒绝（穿越场景仅允许标注当前世界名的物品 add）
    var worldName = (currentWorld && currentWorld.name) || "";
    if (changes.inventory && Array.isArray(changes.inventory) && worldName) {
        changes.inventory = changes.inventory.filter(function(op) {
            if (op && op.op === "add" && op.world && op.world !== worldName) {
                console.warn("[S3] 拒绝跨世界物品 add", op.item_id, op.world, "→", worldName);
                return false;
            }
            return true;
        });
    }

    const prevLocation = s.current_location; // 反向回写需对比「旧地点」判断是否真的发生了移动

    // ★ ⑤ 兜底：旧存档/旧世界无这些字段时不崩，并补默认结构
    if (!s.factions) s.factions = {};
    if (!s.currency) s.currency = { gold: 0 };
    if (!s.crafting_recipes) s.crafting_recipes = [];
    if (!s.equipped) s.equipped = {};

    if (changes.current_location) s.current_location = changes.current_location;
    if (changes.time_mode) s.time_mode = changes.time_mode;

    if (changes.attributes) {
        for (const [k, v] of Object.entries(changes.attributes)) {
            if (typeof v === "string" && v.trim() !== "") {
                s.attributes[k] = v;
            } else if (typeof v === "number") {
                // 兼容旧版数值
                s.attributes[k] = (typeof s.attributes[k] === "number" ? s.attributes[k] : 0) + v;
            }
        }
    }
    if (changes.relationships) {
        for (const [k, v] of Object.entries(changes.relationships)) {
            if (typeof v === "string" && v.trim() !== "") {
                s.relationships[k] = v;
            } else if (typeof v === "number") {
                s.relationships[k] = (typeof s.relationships[k] === "number" ? s.relationships[k] : 0) + v;
            }
        }
    }
    if (changes.skills) {
        for (const [k, v] of Object.entries(changes.skills)) {
            if (typeof v === "string" && v.trim() !== "") {
                s.skills[k] = v;
            } else if (typeof v === "number") {
                s.skills[k] = (typeof s.skills[k] === "number" ? s.skills[k] : 0) + v;
            }
        }
    }
    if (changes.progression) s.progression = { ...s.progression, ...changes.progression };

    if (changes.inventory) {
        for (const op of changes.inventory) {
            if (op.op === "add") {
                const found = s.inventory.find(i => i.item_id === op.item_id);
                if (found) found.count += op.count;
                else s.inventory.push({
                    item_id: op.item_id, name: op.name, count: op.count, world: op.world || null,
                    type: op.type || null, equippable: op.equippable || false,
                    slot: op.slot || null, damage_bonus: op.damage_bonus || 0,
                    ac_bonus: op.ac_bonus || 0, desc: op.desc || ""
                });
            } else if (op.op === "remove") {
                const found = s.inventory.find(i => i.item_id === op.item_id);
                if (found) {
                    found.count -= op.count;
                    if (found.count <= 0) s.inventory = s.inventory.filter(i => i.item_id !== op.item_id);
                }
            } else if (op.op === "clear_world") {
                s.inventory = s.inventory.filter(i => i.world !== op.world);
            }
        }
    }

    // ★ ⑤ 多势力声望 / 阵营系统：每个势力独立累计声望 + 立场
    if (changes.factions) {
        for (const [name, fch] of Object.entries(changes.factions)) {
            if (!s.factions[name]) s.factions[name] = { reputation: 0, stance: "中立" };
            const cur = s.factions[name];
            if (typeof fch.reputation_delta === "number") {
                cur.reputation = Math.max(-100, Math.min(100, cur.reputation + fch.reputation_delta));
            }
            if (fch.stance && typeof fch.stance === "string") cur.stance = fch.stance;
            if (fch.desc && typeof fch.desc === "string") cur.desc = fch.desc;
        }
    }

    // ★ ⑤ 货币经济：按货币种类累加 delta（不允许为负）
    if (changes.currency) {
        for (const [cur, delta] of Object.entries(changes.currency)) {
            if (typeof s.currency[cur] !== "number") s.currency[cur] = 0;
            s.currency[cur] = Math.max(0, s.currency[cur] + (typeof delta === "number" ? delta : 0));
        }
    }

    // ★ C) 商店 NPC（固定货架/定价）：AI 通过 changes.shops 合并/补货店铺到当前世界
    if (changes.shops && Array.isArray(changes.shops) && currentWorld) {
        if (!currentWorld.shops) currentWorld.shops = [];
        for (const incoming of changes.shops) {
            if (!incoming || !incoming.id) continue;
            const exist = currentWorld.shops.find(x => x.id === incoming.id);
            if (!exist) {
                currentWorld.shops.push({
                    id: incoming.id, name: incoming.name || "店铺", owner: incoming.owner || "",
                    location: incoming.location || "", faction: incoming.faction || "",
                    currency: incoming.currency || "gold", stock: Array.isArray(incoming.stock) ? incoming.stock.map(x => ({ ...x })) : []
                });
            } else {
                // 合并：字段覆盖 + 货架按 item_id 合并（补货/改价）
                if (incoming.name) exist.name = incoming.name;
                if (incoming.owner) exist.owner = incoming.owner;
                if (incoming.location) exist.location = incoming.location;
                if (incoming.faction) exist.faction = incoming.faction;
                if (incoming.currency) exist.currency = incoming.currency;
                if (Array.isArray(incoming.stock)) {
                    for (const it of incoming.stock) {
                        const hs = exist.stock.find(x => x.item_id === it.item_id);
                        if (hs) { if (typeof it.price === "number") hs.price = it.price; if (typeof it.count === "number") hs.count = it.count; }
                        else exist.stock.push({ ...it });
                    }
                }
            }
        }
        if (typeof saveWorlds === "function") saveWorlds();
    }

    // ★ C) 阵营任务板：AI 通过 changes.quest_board 发布势力任务到当前世界
    if (changes.quest_board && Array.isArray(changes.quest_board) && currentWorld) {
        if (!currentWorld.quest_board) currentWorld.quest_board = [];
        for (const q of changes.quest_board) {
            if (!q || !q.id) continue;
            if (!currentWorld.quest_board.some(x => x.id === q.id)) {
                currentWorld.quest_board.push({
                    id: q.id, faction: q.faction || "", title: q.title || "未命名任务",
                    desc: q.desc || "", requirements: q.requirements || null,
                    reward: q.reward || null, status: "open"
                });
            }
        }
        if (typeof saveWorlds === "function") saveWorlds();
    }

    // ★ C) AI 驱动的玩家任务推进：accept / turn_in
    if (changes.quests && currentWorld) {
        if (!s.active_quests) s.active_quests = [];
        if (changes.quests.accept && typeof acceptQuest === "function") {
            acceptQuest(s, currentWorld, changes.quests.accept);
        }
        if (changes.quests.turn_in && typeof turnInQuest === "function") {
            const r = turnInQuest(s, currentWorld, changes.quests.turn_in);
            if (r.ok && typeof addBehaviorRecords === "function") {
                const items = (r.applied && r.applied.items || []).join("、");
                addBehaviorRecords([`任务「${changes.quests.turn_in && (currentWorld.quest_board.find(x => x.id === changes.quests.turn_in) || {}).title || "任务"}」已完成。${items ? "获得：" + items : ""}`]);
            }
        }
    }

    // ★ ⑤ 合成配方：AI 在叙事中「发现 / 习得」配方时由 add_recipe 注入（去重）
    if (changes.crafting && changes.crafting.add_recipe) {
        const r = changes.crafting.add_recipe;
        if (r && r.id && !s.crafting_recipes.some(x => x.id === r.id)) {
            s.crafting_recipes.push({
                id: r.id, name: r.name || r.id,
                inputs: r.inputs || [], output: r.output || null, desc: r.desc || ""
            });
        }
    }

    if (changes.completed_events) {
        for (const e of changes.completed_events) {
            if (!s.completed_events.includes(e)) s.completed_events.push(e);
        }
    }

    if (changes.goal_updates) {
        for (const u of changes.goal_updates) {
            const g = s.goals.find(x => x.goal_id === u.goal_id);
            if (!g) continue;
            if (u.status) g.status = u.status;
            if (typeof u.progress === "number") g.progress = Math.max(0, Math.min(100, u.progress));
            if (u.tier) g.tier = u.tier;
        }
    }

    // E4: 叙事层声望（名号/传说度）——替代数值成长，驱动闲置的 progression 反馈
    if (typeof changes.reputation === "number") {
        if (typeof s.reputation !== "number") s.reputation = 0;
        const before = s.reputation;
        s.reputation = Math.max(0, before + changes.reputation);
        const bt = reputationTitle(before), at = reputationTitle(s.reputation);
        if (bt !== at && typeof addBehaviorRecords === "function") {
            addBehaviorRecords([`你的声望已积累到「${at}」，世间开始有人记得你的名字。`]);
        }
    }

    // E7: 危机/张力——随时间或行动升级，制造非战斗的压迫感
    if (typeof changes.tension === "number") {
        if (typeof s.tension !== "number") s.tension = 0;
        const before = s.tension;
        s.tension = Math.max(0, Math.min(100, before + changes.tension));
        const bt = tensionTitle(before), at = tensionTitle(s.tension);
        if (bt !== at && typeof addBehaviorRecords === "function") {
            addBehaviorRecords([`周遭的张力升至「${at}」：似乎有什么正在逼近。`]);
        }
    }

    // B2: 状态效果由引擎权威管理。
    // AI 仅在 state_changes.status_effects 中列出「当前仍生效」的效果（按指令不带 duration）；
    // 引擎据此：① 已在生效的递减其 duration；② 新出现的赋予默认时长；③ AI 不再列出的视为结束并移除。
    if (changes.status_effects) {
        const DEFAULT_STATUS_DURATION = 3; // 未指定时长时，默认持续 3 轮
        // ★ A4: 先剥离 AI 可能误带的 duration（契约是引擎管 duration、AI 只管列出效果名）
        // 防止 AI 既写 duration 又被引擎再递减 → double-decrement
        const incoming = (changes.status_effects || []).map(function(e) {
            if (!e || !e.name) return e;
            var clean = { name: e.name, desc: e.desc || "" };
            // 仅对全新效果保留 AI 的 duration（作为初始值），对已有效果不保留
            if (!(s.status_effects || []).some(function(x) { return x.name === e.name; })) {
                if (typeof e.duration === "number") clean.duration = e.duration;
            }
            return clean;
        });
        const incomingNames = new Set(incoming.map(e => e && e.name).filter(Boolean));
        const existing = s.status_effects || [];
        const result = [];
        // 1) 仍被 AI 列出的已有效果：递减 duration（未被列出 → 结束 → 移除）
        for (const e of existing) {
            if (!incomingNames.has(e.name)) continue;
            const next = { ...e };
            if (typeof next.duration === "number") {
                next.duration -= 1;
                if (next.duration <= 0) continue; // 到期移除
            }
            result.push(next);
        }
        // 2) AI 新列出的效果（之前未生效）：赋予默认时长（若 AI 显式给出 duration 则保留）
        for (const inc of incoming) {
            if (!inc || !inc.name) continue;
            if (existing.some(x => x.name === inc.name)) continue; // 已在上面处理
            const e = { ...inc };
            if (typeof e.duration !== "number") e.duration = DEFAULT_STATUS_DURATION;
            result.push(e);
        }
        s.status_effects = result;
    }

    // B4: 同步维护结构化 NPC 位置账本 npc_states（权威位置来源）
    if (changes.npc_activity) {
        s.npc_activity = { ...(s.npc_activity || {}), ...changes.npc_activity };
        if (!s.npc_states) s.npc_states = {};
        const tcNow = s.current_date || { day: 1, period: "" };
        for (const [name, act] of Object.entries(changes.npc_activity)) {
            s.npc_states[name] = {
                activity: act,
                location: extractLocationFromActivity(act),
                updated_day: tcNow.day,
                updated_period: tcNow.period
            };
        }
    }

    // E2: NPC 深度卡合并——好感度量化累加、日程/秘密/说话风格更新，跨阈值触发关系质变
    if (changes.npc_states) {
        if (!s.npc_states) s.npc_states = {};
        for (const [name, ns] of Object.entries(changes.npc_states)) {
            const cur = s.npc_states[name] || { attitude: 0, mood: "", schedule: {}, secrets: [], speech_style: "", catchphrase: "", location: "" };
            if (typeof ns.attitude === "number") {
                const before = typeof cur.attitude === "number" ? cur.attitude : 0;
                let after = before + ns.attitude;
                after = Math.max(-100, Math.min(100, after)); // 钳制 -100..100
                cur.attitude = after;
                const bt = attitudeTier(before), at = attitudeTier(after);
                if (bt !== at && typeof addBehaviorRecords === "function") {
                    addBehaviorRecords([`你与 ${name} 的关系发生了转变：对方对你变得${tierLabel(at)}（好感${after > before ? "上升" : "下降"}）`]);
                }
            }
            if (ns.mood) cur.mood = ns.mood;
            if (ns.schedule) cur.schedule = { ...(cur.schedule || {}), ...ns.schedule };
            if (Array.isArray(ns.secrets)) cur.secrets = ns.secrets;
            if (ns.speech_style) cur.speech_style = ns.speech_style;
            if (ns.catchphrase) cur.catchphrase = ns.catchphrase;
            if (ns.location) cur.location = ns.location;
            s.npc_states[name] = cur;
        }
    }

    if (changes.is_alive === false) {
        s.is_alive = false;
        s.death_reason = changes.death_reason || "未知原因";
    }

    // ★ H) 基调显式切换：AI 可在 state_changes.tone 中显式改变当前叙事基调，
    //     持久化到 world.tone 并刷新 system prompt 缓存，使下一轮采用新基调。
    if (changes.tone && currentWorld) {
        const nt = normalizeTone(changes.tone);
        if (nt) {
            const prevPrimary = (currentWorld.tone && currentWorld.tone.primary) || null;
            currentWorld.tone = Object.assign({}, currentWorld.tone || {}, nt);
            scheduleSaveWorlds(); // ★ D1: 节流持久化，避免每轮全量写 localStorage（改 tone 也是低频事件）
            invalidateToneGuideCache(); // ★ C1: 只清除基调缓存，system prompt 保持稳定→缓存命中不中断
            if (prevPrimary && prevPrimary !== nt.primary && typeof addBehaviorRecords === "function") {
                const reason = nt.description ? "（" + nt.description + "）" : "";
                addBehaviorRecords(["故事基调悄然转变：" + prevPrimary + " → " + nt.primary + reason]);
            }
        }
    }

    // ★ 常驻记忆·机制 B：从状态变更中识别"永久事实"并钉住（不依赖 AI 自觉）
    const permanentFacts = [];
    if (changes.is_alive === false) {
        permanentFacts.push("玩家已死亡（原因：" + (changes.death_reason || "未知") + "）——终局，不可逆转");
    }
    if (typeof changes.cursed === "string" && changes.cursed.trim()) {
        permanentFacts.push("玩家身负诅咒：" + changes.cursed.trim());
    }
    if (typeof changes.oath === "string" && changes.oath.trim()) {
        permanentFacts.push("玩家立下誓言：" + changes.oath.trim());
    }
    for (const [k, v] of Object.entries(changes)) {
        if (/^oath_/.test(k) && typeof v === "string" && v.trim()) {
            permanentFacts.push("玩家立下誓言（" + k.slice(5) + "）：" + v.trim());
        }
    }
    if (typeof changes.pact === "string" && changes.pact.trim()) {
        permanentFacts.push("玩家缔结契约：" + changes.pact.trim());
    }
    if (typeof changes.allegiance === "string" && changes.allegiance.trim()) {
        permanentFacts.push("玩家阵营归属：" + changes.allegiance.trim());
    }
    if (Array.isArray(changes.deaths)) {
        for (const n of changes.deaths) if (n && n.trim()) permanentFacts.push(n.trim() + " 已死亡（不可逆）");
    }
    if (permanentFacts.length) addPinnedFacts(permanentFacts, "state");

    // ★ 时间推进：统一入口，消除 period / current_date 双路径互相覆盖的 bug
    applyTimeChange(changes);

    // ★ CRPG: 处理战斗数值变更（叙事模式忽略，防止 AI 误注入数值）
    if (!isNarrativeMode() && changes.combat_stats) {
        if (!s.combat_stats) {
            s.combat_stats = (typeof CombatStats !== "undefined")
                ? CombatStats.createDefaults()
                : { max_hp: 12, hp: 12, max_mp: 4, mp: 4, ac: 12, level: 1, xp: 0, xp_to_next: 300,
                    strength: { value: 10, mod: 0, desc: "" }, dexterity: { value: 10, mod: 0, desc: "" },
                    constitution: { value: 10, mod: 0, desc: "" }, intelligence: { value: 10, mod: 0, desc: "" },
                    wisdom: { value: 10, mod: 0, desc: "" }, charisma: { value: 10, mod: 0, desc: "" },
                    in_combat: false };
        }
        const cs = s.combat_stats;
        const ch = changes.combat_stats;
        // ★ A6: 数值字段类型校验——AI 可能返回字符串 "3" 而非数字 3
        function _num(changes, key, fallback) {
            var v = changes[key];
            if (typeof v === "number") return v;
            if (typeof v === "string" && !isNaN(Number(v))) { console.warn("[A6] combat_stats." + key + " 应为数字，收到字符串，已自动转换", v); return Number(v); }
            return fallback;
        }
        if (ch.hp_change !== undefined) { var hpD = _num(ch, "hp_change", 0); cs.hp = Math.max(0, Math.min(cs.max_hp, cs.hp + hpD)); }
        if (ch.mp_change !== undefined) { var mpD = _num(ch, "mp_change", 0); cs.mp = Math.max(0, Math.min(cs.max_mp, cs.mp + mpD)); }
        if (ch.xp_gain !== undefined) CombatStats.awardXp(s, _num(ch, "xp_gain", 0));
        if (ch.attributes) {
            for (const [k, v] of Object.entries(ch.attributes)) {
                if (cs[k]) cs[k] = { ...cs[k], ...v };
            }
        }
        if (typeof ch.ac === "number") cs.ac = ch.ac;
        if (typeof ch.max_hp === "number") {
            const diff = ch.max_hp - cs.max_hp;
            cs.max_hp = ch.max_hp;
            cs.hp = Math.max(1, cs.hp + diff);
        }
        if (typeof ch.max_mp === "number") {
            const diff = ch.max_mp - cs.max_mp;
            cs.max_mp = ch.max_mp;
            cs.mp = Math.max(0, cs.mp + diff);
        }
        if (typeof ch.in_combat === "boolean") cs.in_combat = ch.in_combat;

        // ★ 敌人生成：AI 可通过 spawn_enemies 触发战斗
        if (ch.spawn_enemies && ch.in_combat && typeof CombatEngine !== "undefined") {
            var enemies = [];
            ch.spawn_enemies.forEach(function(spec) {
                var enemy = CombatEngine.spawnEnemy(spec.level || 1, spec.template || null);
                if (spec.name_override) enemy.name = spec.name_override;
                if (spec.count) {
                    for (var i = 0; i < spec.count; i++) {
                        var clone = CombatEngine.spawnEnemy(spec.level || 1, spec.template || null);
                        clone.id = clone.id + '_' + i;
                        if (spec.name_override) clone.name = spec.name_override + (spec.count > 1 ? ' ' + (i + 1) : '');
                        enemies.push(clone);
                    }
                } else {
                    enemies.push(enemy);
                }
            });
            CombatEngine.initCombat(s, enemies);
            // ★ 战斗 ⇄ 地图：把敌人显式放到地图上（标记 _combat，战后清场）
            addMapEnemiesForCombat(s, enemies);
        }
    }

    // ★ CRPG: 处理地图数据
    if (changes.map_data) {
        if (typeof MapDataV1 !== "undefined") {
            const validation = MapDataV1.validate(changes.map_data);
            if (validation.valid) {
                const incoming = changes.map_data;
                const prev = s.current_map;
                // 同尺寸且已有探索进度 → 保留已探索网格（避免 AI 重发地图时迷雾清零）
                const sameStruct = prev && prev.explored
                    && prev.width === incoming.width && prev.height === incoming.height;
                s.current_map = incoming;
                if (!sameStruct) {
                    initFog(s.current_map); // 新地图：全新探索进度
                } else {
                    s.current_map.explored = prev.explored;
                    s.current_map.fog_of_war = (currentWorld && currentWorld.fog_of_war !== false);
                    const pp = findPlayerPos(s.current_map);
                    if (pp) revealAround(s.current_map, pp.row, pp.col, 1);
                }
            } else {
                console.warn("地图数据校验失败:", validation.errors);
            }
        }
    } else if (changes.clear_map) {
        s.current_map = null;
    }

    // ★ 反向回写：叙事 current_location / AI 显式坐标 → 地图玩家位置
    // （与「点击地图→移动玩家→同步 current_location」的正向链路互补）
    if (typeof syncMapPlayerFromNarrative === "function") {
        syncMapPlayerFromNarrative(s, changes, prevLocation);
    }

    // ★ NPC 地图化：npc_states 文本位置 → 地图 npc 实体（在 NPC 账本更新后执行）
    if (typeof syncNpcEntitiesOnMap === "function") {
        syncNpcEntitiesOnMap(s);
    }

    // ★ P1: saveState 已移除，统一由调用方（processTurn/crafting等）在完整流程末尾写入
    // 避免此处每轮与 processTurn 末尾的 saveState 造成同轮双写
    updateGameDayInfo();
}

/* ================= CRPG: 地图 ⇄ 战斗 集成 ================= */
// 说明：地图与叙事/战斗长期"两张皮"——地图只是装饰、点击无效、玩家位置与
// current_location 脱钩、战斗敌人与地图实体不互通。以下函数把三者接起来。

/**
 * 在地图实体列表中找到玩家位置
 * @returns {{row,col}|null}
 */
function findPlayerPos(map) {
    if (!map || !map.entities) return null;
    for (var i = 0; i < map.entities.length; i++) {
        var e = map.entities[i];
        if (e.type === 'player' || e.id === 'player') return { row: e.row, col: e.col };
    }
    return null;
}

/**
 * 在地图指定中心附近找一块「可通行且无实体」的空格（BFS 向外扩散）
 */
function findEmptyCellNear(map, center, maxRadius) {
    maxRadius = maxRadius || 8;
    var maxR = map.height, maxC = map.width;
    var seen = {};
    var q = [{ row: center.row, col: center.col, d: 0 }];
    seen[center.row + ',' + center.col] = true;
    var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    while (q.length) {
        var cur = q.shift();
        if (cur.d >= maxRadius) continue;
        for (var k = 0; k < dirs.length; k++) {
            var r = cur.row + dirs[k][0], c = cur.col + dirs[k][1];
            if (r < 0 || r >= maxR || c < 0 || c >= maxC) continue;
            var key = r + ',' + c;
            if (seen[key]) continue;
            seen[key] = true;
            if (MapDataV1.isWalkable(map, r, c) && !MapDataV1.getEntityAt(map, r, c)) {
                return { row: r, col: c };
            }
            q.push({ row: r, col: c, d: cur.d + 1 });
        }
    }
    return null;
}

/**
 * BFS 寻路：返回从 start 到 goal 的步进数组（不含起点、含终点）；
 * 不可达返回 null；start==goal 返回 []。
 */
function findPath(map, start, goal) {
    if (start.row === goal.row && start.col === goal.col) return [];
    if (!MapDataV1.isWalkable(map, goal.row, goal.col)) return null;
    var maxR = map.height, maxC = map.width;
    var seen = {}; seen[start.row + ',' + start.col] = true;
    var prev = {};
    var q = [{ row: start.row, col: start.col }];
    var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    while (q.length) {
        var cur = q.shift();
        for (var d = 0; d < dirs.length; d++) {
            var r = cur.row + dirs[d][0], c = cur.col + dirs[d][1];
            if (r < 0 || r >= maxR || c < 0 || c >= maxC) continue;
            var key = r + ',' + c;
            if (seen[key]) continue;
            // 目标格允许踩上去；中途格必须可通行且无实体阻挡
            if (!MapDataV1.isWalkable(map, r, c)) continue;
            if (MapDataV1.getEntityAt(map, r, c)) continue;
            seen[key] = true;
            prev[key] = cur.row + ',' + cur.col;
            if (r === goal.row && c === goal.col) {
                var path = [];
                var k = key;
                var startKey = start.row + ',' + start.col;
                while (k !== startKey) {
                    var parts = k.split(',');
                    path.unshift({ row: +parts[0], col: +parts[1] });
                    k = prev[k];
                }
                return path;
            }
            q.push({ row: r, col: c });
        }
    }
    return null;
}

/**
 * 把玩家标记移动到地图目标格（仅移动 + 揭示战争迷雾，不触发骰子、不改动 current_location）。
 * 正向链路（点击地图）与反向链路（叙事定位）共用此函数。
 * @returns {boolean} 是否移动成功
 */
function placePlayerOnMap(gameState, row, col) {
    if (!gameState || !gameState.current_map) return false;
    var map = gameState.current_map;
    if (!MapDataV1.isWalkable(map, row, col)) return false;
    // 目标格若已有实体（非玩家），不允许站上去
    var occupant = MapDataV1.getEntityAt(map, row, col);
    if (occupant && occupant.type !== 'player' && occupant.id !== 'player') return false;

    var ppos = findPlayerPos(map);
    if (!ppos) return false;
    var playerId = null;
    for (var i = 0; i < map.entities.length; i++) {
        if (map.entities[i].type === 'player' || map.entities[i].id === 'player') { playerId = map.entities[i].id; break; }
    }
    if (!playerId) return false;

    MapDataV1.moveEntity(map, playerId, row, col);

    // ★ 战争迷雾：玩家抵达即揭示周围
    if (typeof revealAround === 'function') revealAround(map, row, col, 1);

    saveState();
    if (typeof TileMap !== 'undefined') TileMap.update(map);
    return true;
}

/**
 * 把玩家移动到地图目标格（仅做状态变更+重渲染，不触发骰子）。
 * 同时把 current_location 同步为该格的瓦片名，让地图与叙事位置一致（正向链路）。
 * @returns {boolean} 是否移动成功
 */
function movePlayerOnMap(gameState, row, col) {
    if (!placePlayerOnMap(gameState, row, col)) return false;

    // 同步叙事位置：用目标格瓦片名；无名字则退化为坐标
    var map = gameState.current_map;
    var tid = MapDataV1.getTileAt(map, row, col);
    var tile = (map.tile_legend && map.tile_legend[tid]) || null;
    if (tile && tile.name) gameState.current_location = tile.name;
    else gameState.current_location = '坐标(' + col + ',' + row + ')';

    saveState();
    if (typeof TileMap !== 'undefined') TileMap.update(map);
    return true;
}

/**
 * ★ 战争迷雾：初始化一张地图的探索网格。
 * 根据世界设置决定 fog_of_war 开关；揭示玩家初始位置周围 3×3。
 */
function initFog(map) {
    if (!map || typeof MapDataV1 === 'undefined') return;
    // 世界层可关闭；缺省开启
    map.fog_of_war = !(currentWorld && currentWorld.fog_of_war === false);
    if (!map.explored) {
        map.explored = MapDataV1.createExploredGrid(map.width, map.height);
    }
    var ppos = findPlayerPos(map);
    if (ppos) revealAround(map, ppos.row, ppos.col, 1);
}

/**
 * ★ 战争迷雾：以 (row,col) 为中心、Chebyshev 半径 radius 内全部标记为已探索。
 */
function revealAround(map, row, col, radius) {
    if (!map || !map.explored) return;
    radius = (typeof radius === 'number') ? radius : 1;
    for (var dy = -radius; dy <= radius; dy++) {
        for (var dx = -radius; dx <= radius; dx++) {
            var r = row + dy, c = col + dx;
            if (r < 0 || r >= map.height || c < 0 || c >= map.width) continue;
            map.explored[r][c] = true;
        }
    }
}

/**
 * ★ 反向回写：叙事 current_location / AI 显式坐标 → 地图玩家位置。
 * 触发优先级：
 *  1) changes.player_pos 显式坐标（最可靠，AI 在叙事移动时给出）
 *  2) changes.current_location 命中地图 poi 命名节点（名称匹配）
 *  3) changes.current_location 命中某瓦片图例名（子串匹配，兜底）
 * 仅当存在当前地图且（显式坐标 或 地点确实发生变化）时生效。
 */
/**
 * ★ 文本地点 → 地图坐标 定位（玩家与 NPC 共用）。
 * 匹配优先级：
 *  1) map.poi 命名节点（名称精确/包含匹配）
 *  2) 瓦片图例名（唯一匹配时定位该瓦片首处坐标，兜底）
 * @returns {{row,col}|null}
 */
function locateTextOnMap(map, text) {
    if (!map || !text) return null;
    var loc = String(text).trim();
    if (!loc) return null;

    // poi 名称匹配
    if (map.poi && map.poi.length) {
        for (var i = 0; i < map.poi.length; i++) {
            var pn = map.poi[i].name || '';
            if (!pn) continue;
            if (pn === loc || loc.indexOf(pn) >= 0 || pn.indexOf(loc) >= 0) return { row: map.poi[i].row, col: map.poi[i].col };
        }
    }

    // 图例名匹配（兜底）
    var legend = map.tile_legend || {};
    var cands = [];
    for (var tid in legend) {
        var tname = legend[tid] && legend[tid].name ? legend[tid].name : '';
        if (!tname) continue;
        if (loc.indexOf(tname) >= 0 || tname.indexOf(loc) >= 0) cands.push(tname);
    }
    if (cands.length === 1) {
        var matchName = cands[0];
        for (var y = 0; y < map.height; y++) {
            for (var x = 0; x < map.width; x++) {
                var t = MapDataV1.getTileAt(map, y, x);
                var ln = (map.tile_legend && map.tile_legend[t] && map.tile_legend[t].name) || '';
                if (ln === matchName) return { row: y, col: x };
            }
        }
    }
    return null;
}

/**
 * ★ 反向回写：叙事 current_location / AI 显式坐标 → 地图玩家位置。
 * 触发优先级：
 *  1) changes.player_pos 显式坐标（最可靠，AI 在叙事移动时给出）
 *  2) changes.current_location 命中地图 poi 命名节点（名称匹配）
 *  3) changes.current_location 命中某瓦片图例名（子串匹配，兜底）
 * 仅当存在当前地图且（显式坐标 或 地点确实发生变化）时生效。
 */
function syncMapPlayerFromNarrative(gameState, changes, prevLocation) {
    if (!gameState || !gameState.current_map) return;
    if (gameState.combat_stats && gameState.combat_stats.in_combat) return; // 战斗中位置由战斗逻辑掌控
    var map = gameState.current_map;

    // 1) 显式坐标
    if (changes && changes.player_pos
        && typeof changes.player_pos.row === 'number' && typeof changes.player_pos.col === 'number') {
        placePlayerOnMap(gameState, changes.player_pos.row, changes.player_pos.col);
        return;
    }

    // 2) / 3) 地点名匹配（仅当 current_location 真的变化，用传入的旧地点判断）
    if (!changes || !changes.current_location) return;
    var loc = changes.current_location;
    if (prevLocation && prevLocation === loc) return; // 没变

    var target = locateTextOnMap(map, loc);
    if (target) placePlayerOnMap(gameState, target.row, target.col);
}

/**
 * ★ NPC 地图化：把 npc_states 账本里的文本位置同步成地图 npc 实体。
 *  - 复用 locateTextOnMap 定位坐标；命中地图才挂标记，未命中（地点不在地图上）不挂。
 *  - 随叙事推进，NPC 位置变化会实时 upsert 其地图实体坐标。
 *  - 受战争迷雾约束：渲染层仅在可见格绘制实体（见 tile-map.render），远处/未探索区域的 NPC 不显示。
 *  - 无有效位置的陈旧 npc 实体会被清理，避免幽灵标记。
 */
function syncNpcEntitiesOnMap(gameState) {
    if (!gameState || !gameState.current_map) return;
    var map = gameState.current_map;
    if (!map.entities) map.entities = [];
    var npcStates = gameState.npc_states || {};
    var seen = {};
    var changed = false;

    for (var name in npcStates) {
        if (!npcStates.hasOwnProperty(name)) continue;
        var loc = npcStates[name] && npcStates[name].location;
        if (!loc || !String(loc).trim()) continue;
        var pos = locateTextOnMap(map, loc);
        if (!pos) continue; // 该 NPC 的地点不在地图上，不挂标记
        seen[name] = true;
        var id = 'npc_' + name;
        var existing = null;
        for (var i = 0; i < map.entities.length; i++) {
            if (map.entities[i].id === id) { existing = map.entities[i]; break; }
        }
        if (existing) {
            if (existing.row !== pos.row || existing.col !== pos.col || existing.name !== name) changed = true;
            existing.row = pos.row; existing.col = pos.col;
            existing.name = name; existing.type = 'npc';
        } else {
            changed = true;
            map.entities.push({ row: pos.row, col: pos.col, id: id, name: name, type: 'npc' });
        }
    }

    // 清理不再有有效地图位置的 npc 实体
    var before = map.entities.length;
    map.entities = map.entities.filter(function (e) {
        if (!e.id || e.id.indexOf('npc_') !== 0) return true;
        var nm = e.id.slice(4);
        return seen[nm] === true;
    });
    if (map.entities.length !== before) changed = true;

    if (changed && typeof TileMap !== 'undefined') TileMap.update(map);
}

/**
 * 战斗开始时：把战斗敌人显式放到地图上（标记 _combat，便于战后清场）。
 * 这样地图与战斗敌人是同一批对象，点地图上的敌人就能打到战斗里的敌人。
 */
function addMapEnemiesForCombat(gameState, enemies) {
    if (!gameState || !gameState.current_map || !enemies) return;
    var map = gameState.current_map;
    if (!map.entities) map.entities = [];
    var ppos = findPlayerPos(map) || { row: Math.floor(map.height / 2), col: Math.floor(map.width / 2) };
    enemies.forEach(function(en) {
        if (!en) return;
        // 已存在同 id 的地图实体（AI 预先放置）→ 补标记即可
        var existing = null;
        for (var i = 0; i < map.entities.length; i++) {
            if (map.entities[i].id === en.id) { existing = map.entities[i]; break; }
        }
        if (existing) { existing._combat = true; return; }
        var cell = findEmptyCellNear(map, ppos, 6);
        if (!cell) return;
        map.entities.push({ row: cell.row, col: cell.col, id: en.id, name: en.name, desc: '', type: 'enemy', _combat: true });
    });
}

/**
 * 每轮把地图实体与战斗状态对齐：
 *  - 战斗中：确保存活战斗敌人在图上（缺失则补）；移除已 _combat 但阵亡/清空的敌人
 *  - 非战斗：移除所有 _combat 标记的敌人（战后清场），保留 AI 叙事放置的敌人
 */
function syncMapCombatEntities(gameState) {
    if (!gameState || !gameState.current_map) return;
    var map = gameState.current_map;
    if (!map.entities) return;
    var cs = gameState.combat_stats;
    if (cs && cs.in_combat && cs.enemies) {
        var aliveIds = {};
        cs.enemies.forEach(function(e) { if (e.hp > 0) aliveIds[e.id] = true; });
        // 补建缺失的存活敌人实体
        cs.enemies.forEach(function(e) {
            if (e.hp <= 0) return;
            var has = false;
            for (var i = 0; i < map.entities.length; i++) { if (map.entities[i].id === e.id) { has = true; break; } }
            if (!has) {
                var cell = findEmptyCellNear(map, findPlayerPos(map) || { row: 0, col: 0 }, 6);
                if (cell) map.entities.push({ row: cell.row, col: cell.col, id: e.id, name: e.name, desc: '', type: 'enemy', _combat: true });
            }
        });
        // 移除已阵亡/清空的 _combat 敌人
        map.entities = map.entities.filter(function(m) {
            if (m._combat && !aliveIds[m.id]) return false;
            return true;
        });
    } else {
        // 非战斗：清掉上一场战斗残留的 _combat 敌人
        map.entities = map.entities.filter(function(m) { return !m._combat; });
    }
}



// B3: 统一时间推进，消除 period 与 current_date 双路径相互覆盖
function applyTimeChange(changes) {
    const tc = getTimeConfig();
    const s = gameState;
    // 时间只在 AI 明确给出 period 或 current_date 时推进；日常闲聊不传这些字段 → 不推进（避免每次 +1 天）
    if (!changes.period && !changes.current_date) return;
    if (tc.mode !== "periods") {
        // continuous / hidden：直接合并，不做跨天计算
        if (changes.current_date) s.current_date = { ...s.current_date, ...changes.current_date };
        return;
    }
    // AI 明确给出绝对 day → 直接采用，仅更新 period（避免与跨天 +1 重复计算）
    const explicitDay = (changes.current_date && typeof changes.current_date.day === "number")
        ? changes.current_date.day : null;
    const newPeriod = changes.period
        || (changes.current_date && changes.current_date.period)
        || s.current_date.period;

    if (explicitDay !== null) {
        s.current_date.day = explicitDay;
    } else {
        // 仅给出 period → 按跨天规则推算 day（时段从末尾绕回开头即 +1 天）
        let newDay = s.current_date.day;
        const prevIdx = tc.periods.indexOf(s.current_date.period);
        const newIdx = tc.periods.indexOf(newPeriod);
        if (prevIdx >= 0 && newIdx >= 0 && newIdx < prevIdx) newDay += 1;
        s.current_date.day = newDay;
    }
    s.current_date.period = newPeriod;
}

// B4: 从 NPC 活动描述中抽取已知地点名（尽量结构化其位置）
function extractLocationFromActivity(text) {
    const kb = getWorldLoreKB();
    if (!kb || !kb.snippets || !text) return null;
    const locs = kb.snippets.filter(s => s.category === "地点").map(s => s.title);
    for (const l of locs) if (text.indexOf(l) >= 0) return l;
    return null;
}

// ⑨ 章节/幕结构：基于"已完成主线目标数 + 已完成事件数"确定性推导当前所处幕，
// 不依赖 AI 自觉，复用现有 goals / completed_events。跨幕时记入 acts_log 并钉一条记忆，
// 让 AI 持续感知剧情阶段，避免长线叙事"不知道讲到哪了"。
const ACT_TITLES = [
    null, // 占位，act 从 1 开始
    { title: "第一幕 · 启程", reason: "冒险刚刚开始" },
    { title: "第二幕 · 旅程展开", reason: "已历经数件要事，世界向主角展开" },
    { title: "第三幕 · 暗流涌动", reason: "首个主线目标已完成，局势生变" },
    { title: "第四幕 · 风暴前夕", reason: "两个主线目标已完成，矛盾逼近顶点" },
    { title: "终幕 · 命运交汇", reason: "主线目标全部达成，故事步入终章" }
];

function computeCurrentAct() {
    const gs = gameState;
    if (!gs) return { act: 1, title: ACT_TITLES[1].title, reason: ACT_TITLES[1].reason };
    const goals = gs.goals || [];
    const mainDone = goals.filter(g =>
        g.tier === "main" &&
        (g.status === "completed" || g.completed === true || (typeof g.progress === "number" && g.progress >= 100))
    ).length;
    const evCount = (gs.completed_events || []).length;

    let act;
    if (mainDone >= 3) act = 5;
    else if (mainDone === 2) act = 4;
    else if (mainDone === 1) act = 3;
    else if (evCount >= 6) act = 2;
    else act = 1;

    return { act, title: ACT_TITLES[act].title, reason: ACT_TITLES[act].reason };
}

function updateActProgress() {
    if (!gameState) return;
    if (!gameState.acts_log) gameState.acts_log = [];
    const cur = computeCurrentAct();
    const last = gameState.acts_log[gameState.acts_log.length - 1];
    if (!last || last.act !== cur.act) {
        gameState.acts_log.push({
            act: cur.act,
            title: cur.title,
            reason: cur.reason,
            day: gameState.current_date ? gameState.current_date.day : 1,
            period: gameState.current_date ? gameState.current_date.period : ""
        });
        // 钉一条记忆，让 AI 在长线叙事里持续知道"讲到第几幕了"
        if (typeof addBehaviorRecords === "function") {
            addBehaviorRecords([`【剧情阶段】当前已进入${cur.title}（第${cur.act}幕）：${cur.reason}。`]);
        }
    }
    gameState.current_act = cur; // 持久化，供 UI 直接读取
}

// B1: 目标 deadline 强制执行（引擎侧，不依赖 AI "自觉"）
function checkGoalDeadlines() {
    if (!gameState || !gameState.goals) return;
    const tc = getTimeConfig();
    let failedAny = false;
    // ★ P4: 提前过滤——只检查有 deadline 且未完成/未失败的目标
    const pending = gameState.goals.filter(function(g) {
        return g.deadline && g.status !== "completed" && g.status !== "failed";
    });
    if (pending.length === 0) return false;
    // 按 deadline 排序（最近截止优先），大概率前面的先逾期
    pending.sort(function(a, b) { return dateCompare(a.deadline, b.deadline, tc); });

    for (var i = 0; i < pending.length; i++) {
        var g = pending[i];
        // P4: 如果当前日期还早于 deadline 最紧迫的目标，后面全不用检查
        if (dateCompare(gameState.current_date, g.deadline, tc) <= 0) break;
        g.status = "failed";
        failedAny = true;
        if (typeof addBehaviorRecords === "function") {
            addBehaviorRecords(["目标「" + g.name + "」因超过截止时间（第" + g.deadline.day + "天 " + getPeriodLabel(g.deadline.period) + "）而失败"]);
        }
    }
    return failedAny;
}

// E2: NPC 好感度分层与标签（供 applyStateChanges 跨阈值触发关系质变）
function attitudeTier(a) {
    if (a <= -50) return "hostile";
    if (a < -10) return "wary";
    if (a <= 10) return "neutral";
    if (a < 50) return "friendly";
    return "close";
}
function tierLabel(t) {
    return ({ hostile: "敌对", wary: "戒备", neutral: "平淡", friendly: "友好", close: "亲近" })[t] || "平淡";
}
function reputationTitle(r) {
    if (r >= 80) return "传奇";
    if (r >= 50) return "名人";
    if (r >= 25) return "小有名气";
    if (r >= 10) return "初露头角";
    return "无名之辈";
}
function tensionTitle(t) {
    if (t >= 80) return "危如累卵";
    if (t >= 50) return "山雨欲来";
    if (t >= 25) return "暗流涌动";
    return "平静";
}

// 日期比较：day 优先，再比时段序号；非 periods 模式只看 day
function dateCompare(cur, dl, tc) {
    if (cur.day !== dl.day) return cur.day - dl.day;
    if (tc.mode !== "periods") return 0;
    const ci = tc.periods.indexOf(cur.period);
    const di = tc.periods.indexOf(dl.period);
    if (ci < 0 || di < 0) return 0;
    return ci - di;
}

// E1: 计算一次行动推进的"时段数"（用于世界脉搏计数）
function advancedPeriods(prevDay, prevPeriod, cur) {
    const tc = getTimeConfig();
    if (tc.mode !== "periods") {
        // continuous / hidden：只要 day 变化算 1，否则 0
        return cur.day !== prevDay ? 1 : 0;
    }
    const pi = tc.periods.indexOf(prevPeriod);
    const ci = tc.periods.indexOf(cur.period);
    if (pi < 0 || ci < 0) return 0;
    return Math.max(0, (cur.day - prevDay) * tc.periods.length + (ci - pi));
}

// AI 未返回选项时的智能兜底：根据当前场景/张力/目标/世界脉搏/NPC 好感动态组合多样化选项
function buildSmartFallbackChoices() {
    const loc = gameState.current_location || "这里";
    const npcs = gameState.relationships ? Object.keys(gameState.relationships) : [];
    const kb = getWorldLoreKB();
    const locations = (kb && kb.snippets) ? kb.snippets.filter(s => s.category === "地点").map(s => s.title) : [];
    const events = (kb && kb.snippets) ? kb.snippets.filter(s => s.category === "事件").map(s => s.title) : [];
    const goals = (gameState.goals || []).filter(g => !g.done && !g.failed);
    const tension = (typeof gameState.tension === "number") ? gameState.tension : 0;
    const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const pick = () => {
        const out = [];
        // 1) NPC 互动（按好感给不同措辞）
        if (npcs.length > 0) {
            const npc = rand(npcs);
            const ns = (gameState.npc_states && gameState.npc_states[npc]) || {};
            const att = (typeof ns.attitude === "number") ? ns.attitude : 0;
            const opts = att > 30
                ? [`与${npc}促膝长谈`, `邀${npc}一同行动`, `向${npc}倾诉近况`]
                : att < -30
                    ? [`不动声色地观察${npc}`, `试探${npc}的真实态度`, `与${npc}保持距离`]
                    : [`同${npc}搭话`, `向${npc}打听消息`, `请教${npc}的意见`];
            out.push(rand(opts));
        }
        // 2) 移动 / 探索
        const nearby = locations.filter(l => l !== loc);
        if (nearby.length > 0) {
            const place = rand(nearby);
            out.push(rand([`前往${place}`, `绕道去${place}`, `到${place}碰碰运气`]));
        }
        out.push(rand([`仔细打量${loc}的每一处角落`, `翻找${loc}中可疑的细节`, `在${loc}静静观察周遭`]));
        // 3) 世界脉搏 / 事件线索
        if (events.length > 0) {
            const evt = rand(events);
            out.push(rand([`打听关于「${evt}」的传闻`, `追查「${evt}」背后的真相`, `顺着「${evt}」的线索走下去`]));
        } else if (currentWorld && currentWorld.current_world_events && currentWorld.current_world_events.length) {
            out.push("向人打探近日坊间的风声");
        }
        // 4) 目标驱动
        if (goals.length > 0) {
            const goal = rand(goals);
            const gname = goal.name || "眼下的目标";
            out.push(rand([`谋划如何推进「${gname}」`, `为「${gname}」做些准备`, `寻找「${gname}」的突破口`]));
        }
        // 5) 张力相关
        if (tension >= 60) {
            out.push(rand([`压低身形，戒备四周`, `寻机悄悄脱身`, `正面质问眼前的对峙`]));
        } else if (tension <= 15) {
            out.push(rand([`在${loc}闲坐片刻`, `随性地在附近游走`, `整理一下纷乱的思绪`]));
        }
        // 6) 通用保底
        out.push(rand(["让事情顺着势头发展", "环顾四周，再做打算", "稍作休整，养精蓄锐"]));
        return out;
    };

    const unique = Array.from(new Set(pick()));
    const shuffled = unique.sort(() => Math.random() - 0.5).slice(0, 4);
    return shuffled.map(text => ({ text, action: "fallback" }));
}

/* ================= 交互处理 ================= */
async function submitInput() {
    skipTypewriter();
    const inputEl = document.getElementById("playerInput");
    const input = inputEl.value.trim();
    if (!input) return;
    inputEl.value = "";
    renderChoices([]); // 发送时立即隐藏选项
    await processTurn(input);
}

function chooseOption(index) {
    const choice = currentChoices[index];
    if (!choice) return;
    // ★ U2: 若打字机仍在运行，快进到完整文本
    if (typeof finishTyping === "function") finishTyping();
    document.getElementById("playerInput").value = choice.text;
    // E5: 记录玩家抉择到命运簿（强化蝴蝶效应感）
    if (gameState && choice.text) {
        if (!gameState.choice_log) gameState.choice_log = [];
        gameState.choice_log.push({
            day: gameState.current_date.day,
            period: gameState.current_date.period,
            text: choice.text,
            consequence: choice.consequence || ""
        });
        if (gameState.choice_log.length > 60) gameState.choice_log = gameState.choice_log.slice(-60);
    }
    // 只填入，不自动发送，方便玩家修改
}

/* ================ CRPG: 构建战斗输入 ================ */
function buildCombatInput(baseInput, playerResult, enemyResults) {
    var report = baseInput + "\n\n[战斗回合报告]\n";
    report += CombatEngine.getCombatReport(gameState);

    // 检查战斗是否因玩家死亡或敌人全灭而结束
    var cs = gameState.combat_stats;
    var aliveEnemies = (cs.enemies || []).filter(function(e) { return e.hp > 0; });
    var playerAlive = cs.hp > 0;

    if (aliveEnemies.length === 0 && playerAlive) {
        report += "\n\n战斗胜利！所有敌人已被击败。请在叙事中描述胜利场面和战利品。";
        report += "\n请在 state_changes.combat_stats 中设置 in_combat=false 以及 xp_gain="
            + ((cs.enemies || []).reduce(function(s, e) { return s + (e.xp || 0); }, 0)) + "。";
        CombatEngine.endCombat(gameState, true);
    } else if (!playerAlive) {
        report += "\n\n玩家已被击败！请描述玩家倒下的场景。";
        report += "\n请在 state_changes 中设置 is_alive=false 并给出 death_reason。";
        CombatEngine.endCombat(gameState, false);
    }

    report += "\n\n请根据上述战斗记录生成一段精彩的回合叙事。";
    return report;
}

async function processTurn(input) {
    if (!gameState) return;
    if (gameState.is_alive === false) {
        checkDeathBanner();
        showToast("角色已死亡，无法继续操作", "error", 3000);
        return;
    }

    showLoading("正在思考...");
    // ★ C5/A5: 每轮记录起始时间，供调试面板计算延迟
    var turnStartMs = Date.now();
    var modelInfo = document.getElementById("modelName")?.value || "unknown";
    var turnNum = debugLog.turns.length + 1;
    var turnEntry = {
        turn: turnNum, time: new Date().toISOString(),
        worldId: currentWorld ? currentWorld.id : null, worldName: currentWorld ? currentWorld.name : null,
        model: modelInfo, temperature: getTemperature(), status: "pending",
        inputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, outputTokens: 0, totalTokens: 0, hitRate: "0",
        playerInput: input.slice(0, 200), _startTime: turnStartMs
    };
    debugLog.turns.push(turnEntry);

    // ★ 前端防注入检测
    const injectionCheck = detectPromptInjection(input);
    if (injectionCheck) {
        hideLoading();
        turnEntry.status = "blocked";
        turnEntry.rejectionReason = injectionCheck.label;
        const blockEntry = {
            player: input,
            narrative: "（系统拦截）" + injectionCheck.reason,
            retrieved: [],
            period: gameState.current_date.period,
            day: gameState.current_date.day,
            key_facts: [],
            isWarning: true
        };
        conversationHistory.push(blockEntry);
        saveState();
        renderLog();
        renderChoices([]);
        showToast(injectionCheck.reason, "warn");
        return;
    }
    try {
        // ★ CRPG: 检测动作菜单的规则结果
        let actionMeta = null;
        let combatResult = null;
        const inputEl = document.getElementById("playerInput");
        if (inputEl && typeof ActionMenu !== "undefined") {
            // 检查战斗模式动作（来自 action-menu 的 data-action-type）
            const combatActionType = inputEl.getAttribute("data-action-type");
            inputEl.removeAttribute("data-action-type");
            const inCombat = gameState.combat_stats && gameState.combat_stats.in_combat;

            if (inCombat && typeof CombatEngine !== "undefined" && (combatActionType === "attack" || combatActionType === "cast")) {
                const cs = gameState.combat_stats;
                const aliveEnemies = (cs.enemies || []).filter(function(e) { return e.hp > 0; });
                if (aliveEnemies.length > 0) {
                    // ★ 优先使用点击地图敌人传入的指定目标 id
                    const targetId = inputEl.getAttribute("data-action-target");
                    inputEl.removeAttribute("data-action-target");
                    let target = null;
                    if (targetId) target = aliveEnemies.find(function(e) { return e.id === targetId; });
                    if (!target) target = aliveEnemies[0];
                    if (combatActionType === "attack") {
                        combatResult = CombatEngine.playerAttack(gameState, target.id);
                    } else if (combatActionType === "cast") {
                        combatResult = CombatEngine.playerCast(gameState, target.id);
                    }
                    const enemyResults = CombatEngine.processEnemyTurn(gameState);
                    input = buildCombatInput(input, combatResult, enemyResults);
                    combatResult = { player: combatResult, enemies: enemyResults };
                }
            } else {
                // 检查普通动作（来自 action-menu 的 data-action-result）
                actionMeta = ActionMenu.getStoredResult(inputEl);
                if (actionMeta && actionMeta.rulesResult) {
                    input = input + "\n\n[系统规则结果]\n" + ActionMenu.buildActionReport(actionMeta);
                    if (actionMeta.actionType === "rest") {
                        input += "\n（休息效果已生效，请在叙事中描述环境变化或时间流逝等纯粹叙事内容，不要再输出 hp_change。）";
                    }
                }
            }
        }

        const retrieved = await retrieve(input);
        const resp = await callLLM(input, retrieved);
        hideLoading();

        // 检测是否为非故事内容（拒绝/限制/错误响应）
        const isWarning = isNonStoryResponse(resp.narrative);

        if (isWarning) {
            // ⚠️ 非故事内容：不应用状态变更、不写入知识库、不影响记忆
            const entry = {
                player: input,
                narrative: resp.narrative || "（无内容）",
                retrieved: retrieved.map(s => s.title),
                period: gameState.current_date.period,
                day: gameState.current_date.day,
                key_facts: [],
                isWarning: true
            };
            conversationHistory.push(entry);
            // 明确跳过 applyStateChanges 和 addBehaviorRecords
        } else {
            // ✅ 正常故事内容
            const _prevDay = gameState.current_date.day, _prevPeriod = gameState.current_date.period;
            applyStateChanges(resp.state_changes);
            checkGoalDeadlines(); // B1: 引擎侧强制检查目标 deadline
            updateActProgress(); // ⑨: 推进章节/幕结构（跨幕时钉记忆）

            // E1/G2: 世界脉搏——每推进 5 个时段触发一次，优先消费主响应自带（省独立 API）
            if (currentWorld) {
                if (!currentWorld._pulseCounter) currentWorld._pulseCounter = 0;
                currentWorld._pulseCounter += advancedPeriods(_prevDay, _prevPeriod, gameState.current_date);
                if (currentWorld._pulseCounter >= 5) {
                    currentWorld._pulseCounter = 0;
                    // ★ C4: 仅消费 G2（主响应自带），不再降级为独立 API 调用（省 token+延迟+缓存浪费）
                    if (typeof consumeWorldPulse === "function") consumeWorldPulse(resp);
                }
            }

            const entry = {
                player: input,
                narrative: resp.narrative || "（无叙事）",
                retrieved: retrieved.map(s => s.title),
                period: gameState.current_date.period,
                day: gameState.current_date.day,
                key_facts: resp.key_facts || [],
                pinned_facts: resp.pinned_facts || []
            };
            conversationHistory.push(entry);

            // 推入多轮对话历史（仅正常轮次，警告/错误轮次不入历史，避免污染上下文）
            pushChatTurn(resp._turnUserContent, resp);

            // 添加关键事实到 RAG
            const facts = resp.key_facts || summarizeFactsFromChanges(input, resp.narrative, resp.state_changes);
            addBehaviorRecords(facts);

            // ★ 常驻/常量记忆：AI 在 JSON 中显式标注的永久事实（机制 A）
            if (resp.pinned_facts && resp.pinned_facts.length) {
                addPinnedFacts(resp.pinned_facts, "ai");
            }

            // 如果刚死亡，立即显示横幅 + 禁用输入
            if (gameState.is_alive === false) {
                checkDeathBanner();
                updateInputState();
            }
        }

        createOrUpdateSave();

        // ★ CRPG: 渲染地图（如果有）
        if (!isWarning && typeof TileMap !== "undefined") {
            // ★ 战斗 ⇄ 地图：每轮把地图实体与战斗状态对齐（清场/补建）
            syncMapCombatEntities(gameState);
            if (gameState.current_map) {
                TileMap.render(gameState.current_map);
            } else {
                TileMap.clear();
            }
            updateTopPanelPlaceholder();
        }

        // ★ CRPG: 渲染战斗面板（纯叙事模式跳过）
        if (!isWarning && !isNarrativeMode() && typeof renderCombatPanel === "function") {
            renderCombatPanel();
        }

        renderLog();

        // ★ CRPG: 更新动作菜单
        if (!isWarning && typeof ActionMenu !== "undefined") {
            ActionMenu.render(gameState);
        }

        if (!isWarning) {
            // 计算最终选项（AI 返回空时兜底），必须存储 finalChoices 而非原始空值
            let finalChoices = resp.choices;
            if (!finalChoices || finalChoices.length === 0) {
                finalChoices = buildSmartFallbackChoices();
            }
            // ★ 将最终选项存入记录并持久化（含兜底）
            if (conversationHistory.length > 0) {
                conversationHistory[conversationHistory.length - 1].choices = finalChoices;
            }
            saveState();

            // ★ U2: 打字机非阻塞——先渲染选项，打字在后台进行
            // 玩家可在打字进程中自由滚动历史、查看面板、点击选项
            renderChoices(finalChoices);
            if (typeof renderScenePanel === "function") renderScenePanel();
            startTypewriter(conversationHistory.length - 1);  // 不 await，非阻塞
            if (gameState.is_alive === false) {
                setTimeout(showGameOver, 800);
            }
        } else {
            // 警告内容不提供选项，也不做打字效果
            renderChoices([]);
        }
    } catch (e) {
        hideLoading();
        // ★ U1: 用户主动取消——不存档、不污染历史，温柔恢复输入框
        if (e.message === "CANCELLED_BY_USER") {
            turnEntry.status = "cancelled";
            turnEntry.latencyMs = Date.now() - turnStartMs;
            const inputEl = document.getElementById("playerInput");
            if (inputEl) inputEl.value = input;
            showToast("已取消本次请求", "info");
            return;
        }
        // ★ 日志分离：更新已创建的 turn 入口（非新建，_startTime 已记录）
        turnEntry.status = "error";
        turnEntry.errorType = e.message.includes("JSON 解析失败") ? "parse_failure" :
                       e.message.includes("Failed to fetch") || e.message.includes("NetworkError") ? "network" :
                       e.message.includes("超时") ? "timeout" : "unknown";
        turnEntry.errorMessage = e.message;
        turnEntry.latencyMs = Date.now() - turnStartMs;

        // 网络/API 错误也作为警告展示，不影响游戏状态
        const errorEntry = {
            player: input,
            narrative: "请求失败：" + e.message,
            retrieved: [],
            period: gameState.current_date.period,
            day: gameState.current_date.day,
            key_facts: [],
            isWarning: true
        };
        conversationHistory.push(errorEntry);
        saveState();
        renderLog();
        renderChoices([]);
        // 识别常见错误类型并给出针对性提示
        let errorMsg = e.message;
        if (errorMsg.includes("Failed to fetch") || errorMsg.includes("NetworkError") || errorMsg.includes("failed to fetch")) {
            errorMsg = "网络请求失败（大概率是 CORS 跨域限制）。请在 API 配置中填写 CORS 代理 URL，或使用浏览器 CORS 插件。详见配置弹窗中的提示说明。";
        }
        showToast("出错了：" + errorMsg, "error");
        console.error(e);
    }
}

// G2: 消费主响应自带的 world_pulse 字段，写入世界动态；返回 true 表示已消费（无需再独立调用 generateWorldPulse）
function consumeWorldPulse(resp) {
    if (!resp || !resp.world_pulse || !resp.world_pulse.text) return false;
    if (!currentWorld) return false;
    if (!currentWorld.current_world_events) currentWorld.current_world_events = [];
    currentWorld.current_world_events.push({
        id: "we_" + (typeof genId === "function" ? genId("").slice(0, 16) : Date.now().toString(36)),
        day: (gameState && gameState.current_date && gameState.current_date.day) || 0,
        period: (gameState && gameState.current_date && gameState.current_date.period) || "",
        type: resp.world_pulse.type || "env",
        text: resp.world_pulse.text
    });
    if (currentWorld.current_world_events.length > 12) {
        currentWorld.current_world_events = currentWorld.current_world_events.slice(-12);
    }
    return true;
}

/* ================= 游戏结束 ================= */
function checkDeathBanner() {
    if (!gameState || gameState.is_alive !== false) {
        document.getElementById("deathBanner").classList.add("hidden");
        return;
    }
    const reason = gameState.death_reason || "你的旅程到此为止。";
    document.getElementById("deathBannerText").textContent = "角色已死亡 — " + reason;
    document.getElementById("deathBanner").classList.remove("hidden");
}

function updateInputState() {
    const inputEl = document.getElementById("playerInput");
    const sendBtn = document.querySelector(".send-btn");
    const isDead = gameState && gameState.is_alive === false;
    if (inputEl) {
        inputEl.disabled = isDead;
        inputEl.placeholder = isDead ? "角色已死亡，仅供回顾..." : "输入你想做的事...";
    }
    if (sendBtn) sendBtn.disabled = isDead;
}

function restoreLastChoices() {
    if (!conversationHistory.length) {
        // 新游戏，用世界初始选项
        if (currentWorld && currentWorld.initial_choices && currentWorld.initial_choices.length) {
            currentChoices = currentWorld.initial_choices;
            renderChoices(currentChoices);
        }
        return;
    }
    // 倒序找最后一条有 choices 的记录
    for (let i = conversationHistory.length - 1; i >= 0; i--) {
        const entry = conversationHistory[i];
        if (entry.choices && entry.choices.length) {
            currentChoices = entry.choices;
            renderChoices(currentChoices);
            return;
        }
    }
    // 没找到，检查初始选项
    if (currentWorld && currentWorld.initial_choices && currentWorld.initial_choices.length) {
        currentChoices = currentWorld.initial_choices;
        renderChoices(currentChoices);
    }
}

/* ================= E12 跨周目传承：传说摘要 ================= */
function buildLegendSummary() {
    if (!gameState) return null;
    const s = gameState;
    const worldName = (currentWorld && currentWorld.name) || "未知世界";
    const worldId = (currentWorld && currentWorld.id) || "";
    // E12 进阶：捕获玩家角色名，供新世界 NPC「记起前世名字」
    const heroName = (s.name && String(s.name).trim()) ||
        (currentWorld && currentWorld.hero && String(currentWorld.hero).trim()) || "";
    const day = (s.current_date && s.current_date.day) || 1;
    const period = (s.current_date && s.current_date.period) || "";
    const periodLabel = (typeof DEFAULT_PERIOD_LABELS !== "undefined" && DEFAULT_PERIOD_LABELS[period]) || period || "";
    const rep = s.reputation || 0;
    const ten = s.tension || 0;

    // NPC 关系摘要：按好感绝对值取前 5
    let npcSummary = [];
    if (s.npc_states) {
        npcSummary = Object.keys(s.npc_states)
            .map(n => ({ name: n, attitude: s.npc_states[n].attitude || 0 }))
            .sort((a, b) => Math.abs(b.attitude) - Math.abs(a.attitude))
            .slice(0, 5)
            .map(n => ({ name: n.name, attitude: n.attitude, tier: tierLabel(attitudeTier(n.attitude)) }));
    }

    // 已达成目标
    let goalsDone = [];
    if (s.goals && Array.isArray(s.goals)) {
        goalsDone = s.goals
            .filter(g => g.progress >= 100 || g.status === "done" || g.completed)
            .map(g => g.name);
    }

    const anchors = s.narrative_anchors || {};
    let highlights = [];
    if (s.choice_log && Array.isArray(s.choice_log)) {
        highlights = s.choice_log.slice(-6).map(c => c.text);
    }

    const repTitle = reputationTitle(rep);
    const tenTitle = tensionTitle(ten);
    let summary = `在《${worldName}》中，你行走至第 ${day} 天${periodLabel ? "（" + periodLabel + "）" : ""}。`;
    summary += `你的名号是「${repTitle}」（声望 ${rep}）。`;
    if (npcSummary.length) {
        const top = npcSummary[0];
        summary += `你与${top.name}的羁绊最深——对方对你${top.tier}（好感 ${top.attitude}）。`;
    }
    if (goalsDone.length) {
        summary += `你曾达成：${goalsDone.slice(0, 3).join("、")}。`;
    }
    if (anchors.obsession) summary += `你始终放不下：${anchors.obsession}。`;
    summary += `离别之时，世界正处于「${tenTitle}」（张力 ${ten}）。`;

    return {
        id: "leg_" + (typeof genId === "function" ? genId("").slice(0, 16) : Date.now().toString(36)),
        worldName,
        worldId,
        heroName,
        endedAt: new Date().toISOString(),
        day,
        period,
        periodLabel,
        reputation: rep,
        reputationTitle: repTitle,
        tension: ten,
        tensionTitle: tenTitle,
        npcSummary,
        goalsDone,
        anchors,
        highlights,
        summary
    };
}

function showGameOver() {
    const reason = gameState && gameState.death_reason ? gameState.death_reason : "你的旅程到此为止。";
    document.getElementById("gameOverReason").textContent = reason;

    // E12：生成本周目传说，持久化并在结束弹窗展示
    const legend = buildLegendSummary();
    window.lastLegend = legend;
    if (legend) {
        try { saveLegend(legend); } catch (e) { console.warn("saveLegend failed:", e.message); }
        const block = document.getElementById("gameOverLegendBlock");
        const txt = document.getElementById("gameOverLegend");
        if (block && txt) {
            txt.textContent = legend.summary;
            block.style.display = "block";
        }
    }
    document.getElementById("gameOverOverlay").classList.add("show");
}

function backToHomeAfterGameOver() {
    document.getElementById("gameOverOverlay").classList.remove("show");
    goHome();
}

function reviewDeathScene() {
    document.getElementById("gameOverOverlay").classList.remove("show");
    checkDeathBanner();
    updateInputState();
    renderLog(true);
}

let toastTimer = null;

function showToast(msg, type = "", duration = 2000) {
    const el = document.getElementById("toast");
    if (toastTimer) clearTimeout(toastTimer);
    el.textContent = msg;
    el.className = "toast show " + type;
    toastTimer = setTimeout(() => {
        el.classList.remove("show");
        toastTimer = null;
    }, duration);
}

let loadingStartTime = 0;
let loadingInterval = null;

function showLoading(msg) {
    const el = document.getElementById("loadingIndicator");
    if (!el) return;
    loadingStartTime = Date.now();
    el.querySelector(".loading-text").textContent = msg;
    el.querySelector(".loading-time").textContent = "0.0s";
    el.classList.add("show");
    loadingInterval = setInterval(() => {
        const elapsed = ((Date.now() - loadingStartTime) / 1000).toFixed(1);
        el.querySelector(".loading-time").textContent = elapsed + "s";
    }, 200);
}

function updateLoadingProgress(charCount) {
    const el = document.getElementById("loadingIndicator");
    if (!el || !el.classList.contains("show")) return;
    const elapsed = ((Date.now() - loadingStartTime) / 1000).toFixed(1);
    const kChars = charCount > 1000 ? (charCount / 1000).toFixed(1) + "K" : charCount;
    el.querySelector(".loading-text").textContent = "已接收 " + kChars + " 字符...";
    el.querySelector(".loading-time").textContent = elapsed + "s";
}

function hideLoading() {
    const el = document.getElementById("loadingIndicator");
    if (!el) return;
    el.classList.remove("show");
    if (loadingInterval) { clearInterval(loadingInterval); loadingInterval = null; }
}

// ★ P2: 更新缓存命中率指示器
function updateCacheIndicator() {
    const el = document.getElementById("cacheIndicator");
    if (!el || !lastCacheStats.totalTokens) {
        if (el) el.classList.add("hidden");
        return;
    }
    el.classList.remove("hidden");
    const rate = parseFloat(lastCacheStats.hitRate);
    let cls = "bad";
    if (rate >= 70) cls = "good";
    else if (rate >= 35) cls = "warn";
    el.className = "cache-indicator " + cls;
    el.textContent = "命中 " + lastCacheStats.hitRate + " (" + lastCacheStats.hitTokens + "/" + lastCacheStats.totalTokens + "t)";
    el.title = "缓存命中: " + lastCacheStats.hitTokens + " tokens | 未命中: " + lastCacheStats.missTokens + " tokens";
}
