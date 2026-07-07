function applyStateChanges(changes) {
    if (!changes) return;
    const s = gameState;

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
                else s.inventory.push({ item_id: op.item_id, name: op.name, count: op.count, world: op.world || null });
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
        const incoming = changes.status_effects || [];
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
        if (typeof ch.hp_change === "number") cs.hp = Math.max(0, Math.min(cs.max_hp, cs.hp + ch.hp_change));
        if (typeof ch.mp_change === "number") cs.mp = Math.max(0, Math.min(cs.max_mp, cs.mp + ch.mp_change));
        if (typeof ch.xp_gain === "number") CombatStats.awardXp(s, ch.xp_gain);
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
        }
    }

    // ★ CRPG: 处理地图数据
    if (changes.map_data) {
        if (typeof MapDataV1 !== "undefined") {
            const validation = MapDataV1.validate(changes.map_data);
            if (validation.valid) {
                s.current_map = changes.map_data;
            } else {
                console.warn("地图数据校验失败:", validation.errors);
            }
        }
    } else if (changes.clear_map) {
        s.current_map = null;
    }

    saveState();
    updateGameDayInfo();
}

/* ================= 时间 / 目标 / NPC 辅助 ================= */

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

// B1: 目标 deadline 强制执行（引擎侧，不依赖 AI "自觉"）
function checkGoalDeadlines() {
    if (!gameState || !gameState.goals) return;
    const tc = getTimeConfig();
    let failedAny = false;
    for (const g of gameState.goals) {
        if (!g.deadline || g.status === "completed" || g.status === "failed") continue;
        if (dateCompare(gameState.current_date, g.deadline, tc) > 0) {
            g.status = "failed";
            failedAny = true;
            if (typeof addBehaviorRecords === "function") {
                addBehaviorRecords([`目标「${g.name}」因超过截止时间（第${g.deadline.day}天 ${getPeriodLabel(g.deadline.period)}）而失败`]);
            }
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

// AI 未返回选项时的智能兜底：根据当前场景/位置/NPC生成有意义的替代选项
function buildSmartFallbackChoices() {
    const loc = gameState.current_location || "这里";
    const npcs = gameState.relationships ? Object.keys(gameState.relationships) : [];
    const kb = getWorldLoreKB();
    const locations = (kb && kb.snippets) ? kb.snippets.filter(s => s.category === "地点").map(s => s.title) : [];
    const events = (kb && kb.snippets) ? kb.snippets.filter(s => s.category === "事件").map(s => s.title) : [];

    const choices = [];

    // 优先：与当前在场的 NPC 互动
    if (npcs.length > 0) {
        const npc = npcs[Math.floor(Math.random() * npcs.length)];
        choices.push({ text: "与" + npc + "交谈", action: "talk_to_" + npc });
    }

    // 次优先：移动到附近地点
    const nearby = locations.filter(l => l !== loc);
    if (nearby.length > 0) {
        const place = nearby[Math.floor(Math.random() * nearby.length)];
        choices.push({ text: "前往" + place, action: "go_to_" + place });
    }

    // 再次：探索当前场景或触发事件
    choices.push({ text: "仔细打量" + loc + "的每个角落", action: "explore" });

    // 兜底：让事件继续发展
    choices.push({ text: "让事件继续发展", action: "continue_story" });

    // 第四：推进或休息
    if (events.length > 0) {
        const evt = events[Math.floor(Math.random() * events.length)];
        choices.push({ text: "打听关于「" + evt + "」的线索", action: "investigate" });
    } else {
        choices.push({ text: "在原地稍作停留，整理思绪", action: "rest" });
    }

    // 确保至少 3 个
    if (choices.length < 3) {
        choices.push({ text: "环顾四周", action: "look" });
    }

    // 限制最多 4 个
    return choices.slice(0, 4);
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
    // ★ 前端防注入检测
    const injectionCheck = detectPromptInjection(input);
    if (injectionCheck) {
        hideLoading();
        const model = document.getElementById("modelName")?.value || "unknown";
        const turnNum = debugLog.turns.length + 1;
        debugLog.turns.push({
            turn: turnNum,
            time: new Date().toISOString(),
            worldId: currentWorld ? currentWorld.id : null,
            worldName: currentWorld ? currentWorld.name : null,
            model: model,
            temperature: getTemperature(),
            status: "blocked",
            rejectionReason: injectionCheck.label,
            inputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0,
            outputTokens: 0, totalTokens: 0, hitRate: "0",
            playerInput: input.slice(0, 200)
        });
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
                    const target = aliveEnemies[0];
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

            // E1: 世界脉搏——每推进 2 个时段，生成一条"世界自己发生的事"
            if (currentWorld) {
                if (!currentWorld._pulseCounter) currentWorld._pulseCounter = 0;
                currentWorld._pulseCounter += advancedPeriods(_prevDay, _prevPeriod, gameState.current_date);
                if (currentWorld._pulseCounter >= 2) {
                    currentWorld._pulseCounter = 0;
                    try { await generateWorldPulse(); } catch (e) { console.warn("world pulse failed:", e.message); }
                }
            }

            const entry = {
                player: input,
                narrative: resp.narrative || "（无叙事）",
                retrieved: retrieved.map(s => s.title),
                period: gameState.current_date.period,
                day: gameState.current_date.day,
                key_facts: resp.key_facts || []
            };
            conversationHistory.push(entry);

            // 推入多轮对话历史（仅正常轮次，警告/错误轮次不入历史，避免污染上下文）
            pushChatTurn(resp._turnUserContent, resp);

            // 添加关键事实到 RAG
            const facts = resp.key_facts || summarizeFactsFromChanges(input, resp.narrative, resp.state_changes);
            addBehaviorRecords(facts);

            // 如果刚死亡，立即显示横幅 + 禁用输入
            if (gameState.is_alive === false) {
                checkDeathBanner();
                updateInputState();
            }
        }

        createOrUpdateSave();

        // ★ CRPG: 渲染地图（如果有）
        if (!isWarning && typeof TileMap !== "undefined") {
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

            // 打字完成后显示选项
            await startTypewriter(conversationHistory.length - 1);
            renderChoices(finalChoices);
            if (gameState.is_alive === false) {
                setTimeout(showGameOver, 800);
            }
        } else {
            // 警告内容不提供选项，也不做打字效果
            renderChoices([]);
        }
    } catch (e) {
        hideLoading();
        // ★ 日志分离：即使 parse/API 失败也记录到 debugLog.turns
        const model = document.getElementById("modelName")?.value || "unknown";
        const temp = getTemperature();
        const turnNum = debugLog.turns.length + 1;
        debugLog.turns.push({
            turn: turnNum,
            time: new Date().toISOString(),
            worldId: currentWorld ? currentWorld.id : null,
            worldName: currentWorld ? currentWorld.name : null,
            model: model,
            temperature: temp,
            status: "error",
            errorType: e.message.includes("JSON 解析失败") ? "parse_failure" :
                       e.message.includes("Failed to fetch") || e.message.includes("NetworkError") ? "network" :
                       e.message.includes("超时") ? "timeout" : "unknown",
            errorMessage: e.message,
            inputTokens: 0,
            cacheHitTokens: 0,
            cacheMissTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            hitRate: "0",
            playerInput: input.slice(0, 200)
        });

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
        id: "leg_" + Date.now().toString(36),
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
