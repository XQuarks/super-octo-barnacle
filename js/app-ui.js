
/* ================= 初始化 ================= */
async function init() {
    applyTheme();
    initPanelDivider();
    applyFontSize();
    loadConfig();
    loadSaves();
    loadSnapshots();

    // 逐个加载数据文件，各自独立降级，一个失败不影响其他
    try {
        const res = await fetch("./data/lore_kb.json");
        if (!res.ok) throw new Error("HTTP " + res.status);
        loreKB = await res.json();
    } catch (e) { console.warn("lore_kb.json 加载失败:", e.message); loreKB = { ip: "默认世界", snippets: [] }; }

    try {
        const res = await fetch("./data/lore_kb_with_embeddings.json");
        if (res.ok) loreEmbeddings = await res.json();
    } catch (e) { console.warn("向量知识库加载失败:", e.message); loreEmbeddings = null; }

    // A1: 将预计算向量合并进默认知识库（原代码加载后从未合并，导致混合 RAG 退化）
    if (loreEmbeddings && loreEmbeddings.snippets && loreKB && loreKB.snippets) {
        const embMap = new Map(loreEmbeddings.snippets.map(s => [s.id, s.embedding]));
        loreKB.snippets.forEach(s => { if (embMap.has(s.id)) s.embedding = embMap.get(s.id); });
    }

    try {
        const res = await fetch("./data/system_prompt_template.md");
        if (!res.ok) throw new Error("HTTP " + res.status);
        systemPromptTemplate = await res.text();
    } catch (e) { console.warn("system_prompt_template.md 加载失败:", e.message); systemPromptTemplate = ""; }

    // ★ CRPG: 加载敌人数据
    try {
        const enemyRes = await fetch("./data/enemy_data.json");
        if (enemyRes.ok) {
            window.ENEMY_DATA = await enemyRes.json();
            console.log("敌人数据加载完成，共 " + window.ENEMY_DATA.length + " 种敌人");
        }
    } catch (e) { console.warn("enemy_data.json 加载失败:", e.message); }

    // ★ CRPG: 加载角色创建数据
    try {
        await CharacterCreator.loadDataFile("./data/character_creation.json");
        console.log("角色创建数据加载完成");
    } catch (e) { console.warn("character_creation.json 加载失败:", e.message); }

    // ★ 加载规则集
    try {
        var rsRes = await fetch("./data/rulesets.json");
        if (rsRes.ok) window.RULESETS = await rsRes.json();
    } catch (e) { console.warn("rulesets.json 加载失败:", e.message); }

    try {
        const res = await fetch("./data/initial_state.json");
        if (!res.ok) throw new Error("HTTP " + res.status);
        const state = await res.json();
        const saved = localStorage.getItem(STORAGE_KEYS.state);
        if (saved) {
            try { gameState = JSON.parse(saved); } catch (e) { gameState = deepClone(state); }
        } else {
            gameState = deepClone(state);
        }
    } catch (e) { console.warn("initial_state.json 加载失败:", e.message); gameState = null; }

    // loreKB 已就绪，现在创建 demo 世界
    loadWorlds();

    const savedHistory = localStorage.getItem(STORAGE_KEYS.history);
    if (savedHistory) {
        try { conversationHistory = JSON.parse(savedHistory); } catch (e) { conversationHistory = []; }
    }
    const savedChat = localStorage.getItem(STORAGE_KEYS.chatHistory);
    if (savedChat) {
        try { chatHistory = JSON.parse(savedChat); } catch (e) { chatHistory = []; }
    }
    const savedSummary = localStorage.getItem(STORAGE_KEYS.chatSummary);
    if (savedSummary) {
        try { chatSummary = JSON.parse(savedSummary); } catch (e) { chatSummary = []; }
    }
    renderWorldList();
    renderSaveList();

    // 后台预热 embedding 模型（从工程本地加载，无需 HuggingFace）
    if (loreEmbeddings && typeof transformers !== "undefined") {
        // ★ 设置本地模型路径，从项目 models/ 目录直接加载
        try { transformers.env.localModelPath = "./models/"; } catch(e) {}
        setTimeout(async () => {
            try {
                if (!embeddingModel) {
                    embeddingModel = await transformers.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
                    console.log("Embedding model pre-warmed");
                }
                // G1 性能优化：不在启动时遍历全部 world 预跑 embedding（避免 N 次 ONNX 计算）。
                // 改为「开始游玩」时才对当前 world 惰性重算（见 startGame）。
                // 模型本身仍在此预热，使首次进入游戏时重算尽快可用。
            } catch (e) { console.warn("Embedding model pre-warm failed:", e.message); }
        }, 500);
    }

    // ★ 移动端键盘适配：输入框永远保持在键盘上方可见
    setupMobileKeyboardHandler();

    // ★ A5: 调试面板（?debug=true 开启，含 C5 缓存命中明细）
    if (window.location.search.indexOf("debug=true") !== -1 || window.location.search.indexOf("debug=1") !== -1) {
        window._debugMode = true;
        initDebugPanel();
    }
}

function deepClone(obj) {
    return typeof structuredClone !== "undefined" ? structuredClone(obj) : JSON.parse(JSON.stringify(obj));
}

function loadConfig() {
    const cfg = JSON.parse(localStorage.getItem(STORAGE_KEYS.config) || "{}");
    document.getElementById("baseUrl").value = cfg.baseUrl || "https://api.deepseek.com";
    document.getElementById("corsProxy").value = cfg.corsProxy || "";
    document.getElementById("apiKey").value = cfg.apiKey || "";
    document.getElementById("modelName").value = cfg.modelName || "deepseek-v4-flash";
    document.getElementById("mockMode").checked = cfg.mockMode === true;
    document.getElementById("noStreamMode").checked = cfg.noStreamMode === true;
}

function loadWorlds() {
    const data = localStorage.getItem(STORAGE_KEYS.worlds);
    // 首次启动：从预设 IP 库（js/preset-worlds.js）注入全部预设世界
    worlds = data ? JSON.parse(data) : (typeof buildPresetWorlds === "function" ? buildPresetWorlds() : []);
    // 迁移：删除已下架的旧预设（红楼/魔法学院/蒸汽与魔法），注入缺失的新预设 IP 库
    let changed = false;
    const OLD_PRESET_IDS = ["demo_蒸汽与魔法", "demo_红楼梦", "demo_magic_academy"];
    OLD_PRESET_IDS.forEach(function (id) {
        if (worlds.some(function (w) { return w.id === id; })) {
            worlds = worlds.filter(function (w) { return w.id !== id; });
            changed = true;
        }
    });
    if (typeof buildPresetWorlds === "function") {
        buildPresetWorlds().forEach(function (w) {
            if (!worlds.some(function (e) { return e.id === w.id; })) {
                worlds.push(w);
                changed = true;
            }
        });
    }
    // ★ C) 迁移：为每个世界补 shops / quest_board 默认结构，并给尚无店铺的世界注入一个通用商店 + 通用任务
    worlds.forEach(function (w) {
        if (!Array.isArray(w.shops)) { w.shops = []; changed = true; }
        if (!Array.isArray(w.quest_board)) { w.quest_board = []; changed = true; }
        if (typeof seedDefaultShops === "function") seedDefaultShops(w);
    });
    if (changed) saveWorlds();
}

// ★ C) 给尚无店铺的世界注入一个通用商店（固定货架/定价）+ 一个通用阵营任务。
// 不改动 preset-worlds.js，避免预设 canon 测试回归；仅运行时按需补齐。
function seedDefaultShops(world) {
    if (!world) return;
    if (!Array.isArray(world.shops)) world.shops = [];
    if (!Array.isArray(world.quest_board)) world.quest_board = [];
    if (world.shops.length === 0) {
        world.shops.push({
            id: "shop_general_" + world.id,
            name: "杂货铺",
            owner: "老掌柜",
            location: "城镇集市",
            currency: "gold",
            stock: [
                { item_id: "potion", name: "治疗药水", price: 20, count: 5, type: "consumable", desc: "恢复些许伤势。" },
                { item_id: "bread", name: "干粮", price: 3, count: 20, type: "consumable", desc: "果腹之物。" },
                { item_id: "torch", name: "火把", price: 5, count: 10, type: "material", desc: "照亮幽暗角落。" },
                { item_id: "rope", name: "绳索", price: 8, count: 6, type: "material", desc: "攀援与捆缚皆宜。" }
            ]
        });
    }
    // 若世界尚无任何开放任务，注入一条通用「跑腿」任务（无势力归属，奖励少量货币）
    if (world.quest_board.length === 0) {
        world.quest_board.push({
            id: "q_runner_" + world.id,
            faction: "",
            title: "集市跑腿",
            desc: "帮杂货铺老掌柜把一封信送到城门口的守卫手中。",
            requirements: null,
            reward: { currency: { gold: 15 }, items: [], reputation: {} },
            status: "open"
        });
    }
}

function createDemoWorld(name, type, desc, tags) {
    return {
        id: "demo_" + name,
        name,
        type,
        desc,
        hero: "",
        createdAt: new Date().toISOString().split("T")[0],
        tags,
        schema: defaultWorldSchema("修仙"),
        initial_state: null,
        lore_kb: deepClone(loreKB || { ip: name, snippets: [] }),
        system_prompt: "",
        behavior_records: [],
        pinned_facts: [],
        oracle: { enabled: true, chaos_factor: 5 },
        fog_of_war: true,
        initial_choices: []
    };
}

function loadSaves() {
    const data = localStorage.getItem(STORAGE_KEYS.saves);
    saves = data ? JSON.parse(data) : [];
}

/* ================= D 分支快照：存储读写 ================= */
function loadSnapshots() {
    try {
        const data = localStorage.getItem(STORAGE_KEYS.snapshots);
        snapshots = data ? JSON.parse(data) : [];
    } catch (e) {
        console.warn("snapshots 读取失败:", e.message);
        snapshots = [];
    }
}

function saveSnapshots() {
    try {
        // 快照含完整 world（可能带 embedding），体积偏大；配额不足时给出警告但不致命
        localStorage.setItem(STORAGE_KEYS.snapshots, JSON.stringify(snapshots));
    } catch (e) {
        console.warn("snapshots 持久化失败（可能 localStorage 配额不足）:", e.message);
        showToast("分支快照保存失败：本地存储空间不足，请删除部分旧快照", "error");
    }
}

// ★ A3: 检测 localStorage 配额耗尽错误（跨浏览器兼容）
function _isQuotaError(e) {
    return e && (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
        (e.message && (e.message.indexOf("quota") !== -1 || e.message.indexOf("QUOTA") !== -1 ||
         e.message.indexOf("storage") !== -1)));
}

function saveWorlds() {
    try {
        // 不持久化片段向量（384 维 embedding），避免 localStorage 膨胀/配额超限；
        // 向量在加载时由 computeEmbeddingsForWorld 重新计算（见 init）。
        localStorage.setItem(STORAGE_KEYS.worlds, JSON.stringify(worlds, (k, v) => (k === "embedding" ? undefined : v)));
    } catch (e) {
        if (_isQuotaError(e)) {
            showToast("存储空间不足！建议在首页清理不用的世界以释放空间。", "warn");
        }
        console.error("worlds 持久化失败:", e.message);
    }
}

function saveSaves() {
    localStorage.setItem(STORAGE_KEYS.saves, JSON.stringify(saves));
}

/* ================= E12 跨周目传承：传说本地存档 ================= */
function loadLegends() {
    try {
        const data = localStorage.getItem(STORAGE_KEYS.legends);
        return data ? JSON.parse(data) : [];
    } catch (e) {
        console.warn("legends 读取失败:", e.message);
        return [];
    }
}

function saveLegend(legend) {
    if (!legend || !legend.id) return;
    const list = loadLegends().filter(l => l.id !== legend.id);
    list.unshift(legend);
    // 最多保留 20 段传说，避免 localStorage 膨胀
    const capped = list.slice(0, 20);
    localStorage.setItem(STORAGE_KEYS.legends, JSON.stringify(capped));
}

function saveState(serialized) {
    // 如果调用方已预序列化，直接使用，避免重复 JSON.stringify
    const stateStr = serialized ? serialized.state : JSON.stringify(gameState);
    const historyStr = serialized ? serialized.history : JSON.stringify(conversationHistory);
    const chatStr = serialized ? serialized.chatHistory : JSON.stringify(chatHistory);
    try {
        localStorage.setItem(STORAGE_KEYS.state, stateStr);
        localStorage.setItem(STORAGE_KEYS.history, historyStr);
        localStorage.setItem(STORAGE_KEYS.chatHistory, chatStr);
        localStorage.setItem(STORAGE_KEYS.chatSummary, JSON.stringify(chatSummary));
    } catch (e) {
        if (_isQuotaError(e)) {
            showToast("游戏数据保存失败：存储空间不足。建议清理旧存档。", "warn");
        }
        console.warn("localStorage 写入失败，可能空间不足", e);
    }
}

function saveConfig() {
    const cfg = {
        baseUrl: document.getElementById("baseUrl").value.trim(),
        corsProxy: document.getElementById("corsProxy").value.trim(),
        apiKey: document.getElementById("apiKey").value.trim(),
        modelName: document.getElementById("modelName").value.trim(),
        mockMode: document.getElementById("mockMode").checked,
        noStreamMode: document.getElementById("noStreamMode").checked
    };
    localStorage.setItem(STORAGE_KEYS.config, JSON.stringify(cfg));
}

/* ================= 世界模板配置 ================= */
// 注意：buildApiUrl / normalizeApiBaseUrl 已上移至 app-core.js（纯函数，I 项 URL 拼接健壮性）。
//       app-core 先于本文件加载，全局 buildApiUrl 即为健壮版本，本文件不再重复定义，避免旧版覆盖。
function defaultWorldSchema(styleHint) {
    const isXianxia = /仙|侠|修|道|武|玄|魔/.test(styleHint);
    const isMagicSchool = /霍格沃茨|哈利|魔法|学院|年级|巫师/.test(styleHint);
    if (isMagicSchool) {
        return {
            progression_label: "年级",
            progression_path_label: "学院",
            has_skills: true,
            skill_label: "课程/法术",
            attribute_labels: {
                courage: "勇气", perception: "观察", patience: "耐心", luck: "运气", will: "意志"
            },
            time_periods: DEFAULT_PERIOD_LABELS,
            game_over_conditions: ["is_alive === false"]
        };
    }
    return {
        progression_label: isXianxia ? "境界" : "等级",
        progression_path_label: isXianxia ? "修行路线" : "职业/分支",
        has_skills: true,
        skill_label: isXianxia ? "功法/技艺" : "技能",
        attribute_labels: {
            courage: "胆识", perception: "洞察", patience: "耐心", luck: "气运", will: "心志"
        },
        time_periods: DEFAULT_PERIOD_LABELS,
        game_over_conditions: ["is_alive === false"]
    };
}

function getWorldSchema(world) {
    return (world && world.schema) || defaultWorldSchema(world && world.name);
}

/* ================= 界面切换 ================= */
function showScreen(id) {
    document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
    document.getElementById(id).classList.add("active");
}

function goHome() {
    // 回到主界面时恢复"编辑主角"按钮
    var heroBtn = document.getElementById("heroEditBtn");
    if (heroBtn) heroBtn.style.display = "";
    showScreen("homeScreen");
}

// 记录每轮 API 调用的统计信息
function logTurnStats(hit, miss, total, usage) {
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
        inputTokens: usage.prompt_tokens || total,
        cacheHitTokens: hit,
        cacheMissTokens: miss,
        outputTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0,
        hitRate: total > 0 ? (hit / total * 100).toFixed(1) : "0"
    });
}

function exportDebugLog() {
    const blob = new Blob([JSON.stringify(debugLog, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.download = "aether_debug_log_" + new Date().toISOString().slice(0, 10) + ".json";
    a.href = url;
    a.click();
    URL.revokeObjectURL(url);
    showToast("调试日志已导出 (" + debugLog.turns.length + " 轮对话记录)", "success");
}

function exportStory() {
    if (!conversationHistory || !conversationHistory.length) {
        showToast("还没有剧情可以导出", "warn");
        return;
    }
    const worldName = currentWorld ? currentWorld.name : "未知世界";
    let text = worldName + " · 剧情记录\n";
    text += "导出时间：" + new Date().toLocaleString() + "\n";
    text += "=".repeat(50) + "\n\n";

    conversationHistory.forEach((entry, i) => {
        if (entry.isWarning) return;
        if (entry.player) {
            text += "【玩家 · 第 " + entry.day + " 天 · " + (entry.period || "") + "】\n";
            text += "> " + entry.player + "\n\n";
        }
        text += entry.narrative + "\n\n";
        text += "-".repeat(40) + "\n\n";
    });

    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safeName = worldName.replace(/[\\/:*?"<>|]/g, "_");
    const dateStr = new Date().toISOString().slice(0, 10);
    a.download = safeName + "_" + dateStr + ".txt";
    a.href = url;
    a.click();
    URL.revokeObjectURL(url);
    showToast("剧情已导出为 TXT 文件", "success");
}

function showModal(id) {
    const el = document.getElementById(id);
    el.classList.add("show");
}

function closeModal(id) {
    const el = document.getElementById(id);
    el.classList.remove("show");
}

function showApiModal() {
    showModal("apiModal");
}

function showSettingsModal() {
    showModal("settingsModal");
    updateFontSizeButtons();
}

let fontSizeSetting = localStorage.getItem("octo_fontsize") || "normal";

// E12：待带入新世界的传说（由「带入新世界」或导入文件设置）
var pendingInheritedLegend = null;

function applyFontSize() {
    const zooms = { small: "0.85", normal: "1", large: "1.18" };
    document.body.style.zoom = zooms[fontSizeSetting];
}

function changeFontSize(size) {
    fontSizeSetting = size;
    localStorage.setItem("octo_fontsize", size);
    applyFontSize();
    updateFontSizeButtons();
}

function updateFontSizeButtons() {
    ["small", "normal", "large"].forEach(s => {
        const btn = document.getElementById("font" + s.charAt(0).toUpperCase() + s.slice(1));
        if (btn) btn.classList.toggle("active", fontSizeSetting === s);
    });
}

let temperatureSetting = parseFloat(localStorage.getItem("octo_temperature") || "0.5");

function showSettingsModal() {
    showModal("settingsModal");
    updateFontSizeButtons();
    document.getElementById("temperatureSlider").value = temperatureSetting;
    updateTempLabel();
}

function updateTempLabel() {
    const v = parseFloat(document.getElementById("temperatureSlider").value);
    temperatureSetting = v;
    localStorage.setItem("octo_temperature", v.toString());
    const desc = v <= 0.3 ? "严谨模式（高度一致）" : v <= 0.5 ? "剧情模式（稳定连贯）" : v <= 0.7 ? "均衡模式（适中开放）" : "创意模式（自由发散）";
    document.getElementById("tempLabel").textContent = v.toFixed(1) + " — " + desc;
}

function getTemperature() {
    return temperatureSetting;
}

function showCreateWorldModal() {
    resetCwTabs();
    showModal("createWorldModal");
    // E12：打开创建界面时刷新「带入传说」提示
    refreshInheritedLegendUI();
}

/* ================= E12 跨周目传承：导出 / 带入 / 导入 ================= */
function downloadLegendFile(legend) {
    if (!legend) return;
    const data = JSON.stringify(legend, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `传说_${legend.worldName}_${legend.endedAt.slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function exportLegend() {
    const legend = window.lastLegend;
    if (!legend) { showToast("暂无可导出的传说", "error"); return; }
    downloadLegendFile(legend);
    showToast("传说已导出为 JSON 文件", "success");
}

function inheritLegendToNewWorld() {
    const legend = window.lastLegend;
    if (!legend) { showToast("暂无可带入的传说", "error"); return; }
    pendingInheritedLegend = legend;
    showCreateWorldModal();
    showToast("已带入上一段传说，创建世界时会作为彩蛋注入", "success");
}

// 在创建世界弹窗中显示/隐藏「将带入传说」提示（含评级 + 机制性馈赠预览）
function refreshInheritedLegendUI() {
    const notice = document.getElementById("inheritedLegendNotice");
    if (!notice) return;
    if (pendingInheritedLegend) {
        const info = buildInheritedLegend(pendingInheritedLegend);
        const nameEl = document.getElementById("inheritedLegendName");
        const tierEl = document.getElementById("inheritedLegendTier");
        const bonusEl = document.getElementById("inheritedLegendBonus");
        if (nameEl) nameEl.textContent =
            pendingInheritedLegend.worldName + "（" + (pendingInheritedLegend.reputationTitle || "无名旅人") + "）";
        if (tierEl) tierEl.textContent = "【" + info.tierLabel + "级传说】";
        if (bonusEl) {
            const b = info.bonuses;
            const parts = [];
            if (b.reputation) parts.push("声望 +" + b.reputation);
            if (b.currency && b.currency.gold) parts.push("金币 +" + b.currency.gold);
            if (b.npcAttitude) parts.push("特殊 NPC 好感 +" + b.npcAttitude);
            if (b.startingItem) parts.push("遗物「" + b.startingItem + "」");
            bonusEl.textContent = parts.length ? "开局馈赠：" + parts.join("，") : "开局馈赠：微薄祝福";
        }
        notice.style.display = "flex";
    } else {
        notice.style.display = "none";
    }
}

function clearInheritedLegend() {
    pendingInheritedLegend = null;
    refreshInheritedLegendUI();
    showToast("已取消带入传说", "info");
}

// 从导出的 JSON 文件导入传说
function importLegendFile(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
        try {
            const legend = JSON.parse(reader.result);
            if (!legend || !legend.summary) throw new Error("文件格式不正确");
            pendingInheritedLegend = legend;
            refreshInheritedLegendUI();
            showToast("已导入传说：" + (legend.worldName || "未知世界"), "success");
        } catch (e) {
            showToast("传说文件解析失败：" + e.message, "error");
        }
    };
    reader.readAsText(file);
    event.target.value = "";
}

function saveApiConfig() {
    saveConfig();
    closeModal("apiModal");
    showToast("API 配置已保存", "success");
}

/* ================= 文件上传处理 ================= */
function autoFillWorldDesc() {
    const descEl = document.getElementById("worldDesc");
    if (descEl && !descEl.value.trim()) {
        descEl.value = "原作世界观";
    }
}
function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    const area = document.getElementById("fileUploadArea");
    const text = document.getElementById("fileUploadText");

    if (file.name.endsWith(".txt")) {
        const reader = new FileReader();
        reader.onload = function(e) {
            sourceFileContent = e.target.result;
            autoFillWorldDesc();
            area.classList.add("has-file");
            text.innerHTML = `<span class="file-name">${escapeHtml(file.name)}</span> (${formatFileSize(file.size)}) <span class="file-remove" onclick="clearSourceFile(event)">✕</span>`;
            area.onclick = null;
        };
        reader.readAsText(file, "UTF-8");
    } else if (file.name.endsWith(".docx")) {
        if (typeof mammoth !== "undefined") {
            const reader = new FileReader();
            reader.onload = function(e) {
                mammoth.extractRawText({ arrayBuffer: e.target.result })
                    .then(function(result) {
                        sourceFileContent = result.value;
                        autoFillWorldDesc();
                        area.classList.add("has-file");
                        text.innerHTML = `<span class="file-name">${escapeHtml(file.name)}</span> (${formatFileSize(file.size)}) <span class="file-remove" onclick="clearSourceFile(event)">✕</span>`;
                        area.onclick = null;
                    })
                    .catch(function(err) {
                        showToast("DOCX 解析失败：" + err.message, "error");
                    });
            };
            reader.readAsArrayBuffer(file);
        } else {
            showToast("DOCX 解析需要 mammoth.js，请使用 .txt 格式", "error");
        }
    } else if (file.name.endsWith(".epub")) {
        if (typeof JSZip !== "undefined") {
            const reader = new FileReader();
            reader.onload = function(e) {
                text.innerHTML = "正在解析 EPUB...";
                parseEpub(e.target.result)
                    .then(function(extracted) {
                        sourceFileContent = extracted;
                        autoFillWorldDesc();
                        area.classList.add("has-file");
                        text.innerHTML = `<span class="file-name">${escapeHtml(file.name)}</span> (${formatFileSize(file.size)}) <span class="file-remove" onclick="clearSourceFile(event)">✕</span>`;
                        area.onclick = null;
                        showToast("EPUB 解析完成，" + Math.round(extracted.length / 1000) + "K 字符", "success");
                    })
                    .catch(function(err) {
                        showToast("EPUB 解析失败：" + err.message, "error");
                        text.innerHTML = "点击上传 TXT / DOCX / EPUB 文件";
                    });
            };
            reader.readAsArrayBuffer(file);
        } else {
            showToast("EPUB 解析需要 JSZip，请使用 .txt 格式", "error");
        }
    }
}

async function parseEpub(arrayBuffer) {
    const zip = await JSZip.loadAsync(arrayBuffer);
    let containerXml = null;
    for (const name of Object.keys(zip.files)) {
        if (name.toLowerCase().endsWith("container.xml")) {
            containerXml = await zip.files[name].async("string");
            break;
        }
    }
    if (!containerXml) throw new Error("无法找到 container.xml");
    const rootfileMatch = containerXml.match(/full-path="([^"]+)"/) || containerXml.match(/full-path='([^']+)'/);
    if (!rootfileMatch) throw new Error("无法解析 OPF 路径");
    const opfPath = rootfileMatch[1];
    const opfContent = await zip.files[opfPath].async("string");
    const spineMatch = opfContent.match(/<spine[^>]*>([\s\S]*?)<\/spine>/);
    const manifestMatch = opfContent.match(/<manifest>([\s\S]*?)<\/manifest>/);
    if (!spineMatch || !manifestMatch) throw new Error("无法解析 OPF");
    const spineItems = [...spineMatch[1].matchAll(/idref="([^"]+)"/g)].map(m => m[1]);
    const manifestItems = [...manifestMatch[1].matchAll(/id="([^"]+)"[^>]*href="([^"]+)"/g)].map(m => ({ id: m[1], href: m[2] }));
    const idToHref = {};
    manifestItems.forEach(item => { idToHref[item.id] = item.href; });
    const opfDir = opfPath.substring(0, opfPath.lastIndexOf("/"));
    let fullText = "";
    for (const idref of spineItems) {
        const href = idToHref[idref];
        if (!href) continue;
        const targetPath = opfDir ? opfDir + "/" + href : href;
        let html;
        try { html = await zip.files[targetPath].async("string"); }
        catch (e) { try { html = await zip.files[href].async("string"); } catch (e2) { continue; } }
        let text = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
            .replace(/<[^>]+>/g, "\n").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&\w+;/g, " ").replace(/&#\d+;/g, " ");
        text = text.replace(/\n\s*\n/g, "\n").trim();
        if (text.length > 50) fullText += text + "\n\n";
    }
    if (!fullText) throw new Error("未能提取到文本内容");
    return fullText;
}

function clearSourceFile(e) {
    if (e) e.stopPropagation();
    sourceFileContent = "";
    const area = document.getElementById("fileUploadArea");
    const text = document.getElementById("fileUploadText");
    const input = document.getElementById("sourceFile");
    area.classList.remove("has-file");
    text.innerHTML = `点击上传 TXT / DOCX 文件`;
    area.onclick = function() { document.getElementById("sourceFile").click(); };
    input.value = "";
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/* ================ 创建世界页签导航 ================ */
var cwCurrentTab = 0;
var cwTabOrder = ['cwSettings', 'cwRules', 'cwStyle', 'cwAdvanced'];

function cwSwitchTab(index) {
    cwCurrentTab = index;
    cwTabOrder.forEach(function(id, i) {
        var panel = document.getElementById(id);
        var tab = document.querySelector('#cwTabs .cw-tab[data-tab="' + id + '"]');
        if (panel) panel.classList.toggle('show', i === index);
        if (tab) tab.classList.toggle('active', i === index);
    });
    var indicator = document.getElementById('cwTabIndicator');
    if (indicator) indicator.textContent = (index + 1) + '/' + cwTabOrder.length;

    var prevBtn = document.getElementById('cwPrevBtn');
    var nextBtn = document.getElementById('cwNextBtn');
    if (prevBtn) prevBtn.style.display = index === 0 ? 'none' : '';
    if (nextBtn) nextBtn.textContent = index === cwTabOrder.length - 1 ? '确认生成' : '下一步';
}

function cwNextTab() {
    if (cwCurrentTab < cwTabOrder.length - 1) {
        cwSwitchTab(cwCurrentTab + 1);
    } else {
        generateWorld();
    }
}

function cwPrevTab() {
    if (cwCurrentTab > 0) cwSwitchTab(cwCurrentTab - 1);
}

// 页签点击
document.addEventListener('DOMContentLoaded', function() {
    var tabBtns = document.querySelectorAll('#cwTabs .cw-tab');
    tabBtns.forEach(function(btn) {
        btn.addEventListener('click', function() {
            var idx = cwTabOrder.indexOf(this.getAttribute('data-tab'));
            if (idx >= 0) cwSwitchTab(idx);
        });
    });
});

// ★ 重置页签到第一页
function resetCwTabs() {
    cwCurrentTab = 0;
    cwSwitchTab(0);
}

/* ================ 规则集选择 ================ */
var selectedRuleset = 'dnd';

function selectRuleset(id, el) {
    selectedRuleset = id;
    document.querySelectorAll('.ruleset-card').forEach(function(c) { c.classList.remove('selected'); });
    if (el) el.classList.add('selected');
}

function updateRuleFreedomLabel(value) {
    var labels = [null, '高度规则 — 骰子严格决定一切', '偏规则 — 骰子主导，叙事辅助', '适中 — 规则约束与叙事自由平衡', '偏叙事 — 叙事主导，骰子辅助', '极简规则 — 几乎纯叙事体验'];
    var el = document.getElementById('ruleFreedomLabel');
    if (el) el.textContent = labels[value] || '';
}

function updateWorldFreedomLabel(value) {
    var labels = [null, '严格遵循源材料 — 剧情不偏离设定', '以源材料为锚 — 在设定内发展', '适中 — 参考世界观，适度创新', '自由发挥 — 只保留核心设定框架', '完全自由 — 仅借用世界观背景'];
    var el = document.getElementById('worldFreedomLabel');
    if (el) el.textContent = labels[value] || '';
}

function updateChaosLabel(value) {
    var v = parseInt(value) || 5;
    var labels = {
        1: '极少意外（1/9）— 几乎线性，只在关键处偶发变数',
        2: '偶发意外（2/9）— 长线才来一次转折',
        3: '偏低（3/9）— 偶尔的小惊喜',
        4: '偏低（4/9）— 时不时来点意外',
        5: '适中（5/9）— 偶然的意外，增添未知感',
        6: '偏高（6/9）— 意外渐多，故事常有变数',
        7: '偏高（7/9）— 频繁转折，充满未知',
        8: '很高（8/9）— 几乎每轮都有意外',
        9: '意外拉满（9/9）— 每轮必有变数'
    };
    var el = document.getElementById('chaosFactorLabel');
    if (el) el.textContent = labels[v] || ('混沌因子 ' + v + '/9');
}

/* ================= 文风 & 自由度选择 ================= */
function onWorldTypeChange(value) {
    const ipNameField = document.getElementById("ipNameField");
    const worldDescHint = document.getElementById("worldDescHint");
    const worldDescTextarea = document.getElementById("worldDesc");
    if (value === "ip") {
        ipNameField.classList.add("show");
        worldDescHint.innerHTML = "你可以直接使用原作的世界观描述，也可以在此基础上进行修改和扩展——例如调整力量体系、加入新势力、改变时间线等。描述越详细，AI 生成的剧情越贴合你的构想。";
        worldDescTextarea.placeholder = "可以直接填写原作的世界观概述，也可以在此基础上修改...\n例如：在原著的世界观基础上，增加了一个隐秘的地下组织...";
        // 若描述为空，自动填入"原作世界观"
        if (!worldDescTextarea.value.trim()) {
            worldDescTextarea.value = "原作世界观";
        }
    } else {
        ipNameField.classList.remove("show");
        worldDescHint.innerHTML = "描述越详细，AI 生成的内容越贴近你的预期。";
        worldDescTextarea.placeholder = "描述这个世界的规则、力量体系、主要势力、地点、人物关系等...";
    }
}

function selectStyleRef(value, el) {
    document.querySelectorAll("#styleRefGroup .radio-option").forEach(o => o.classList.remove("selected"));
    document.querySelectorAll("#styleRefGroup input[type=radio]").forEach(r => r.checked = false);
    el.classList.add("selected");
    el.querySelector("input[type=radio]").checked = true;
    const customField = document.getElementById("customStyleField");
    if (value === "custom") {
        customField.classList.add("show");
    } else {
        customField.classList.remove("show");
    }
}

function getSelectedStyleRef() {
    const checked = document.querySelector("input[name='styleRef']:checked");
    return checked ? checked.value : "original";
}

/* ================= 特殊要求 ================= */
function toggleCustomPrefix(enabled, el) {
    document.querySelectorAll("#customPrefixGroup .radio-option").forEach(o => o.classList.remove("selected"));
    document.querySelectorAll("#customPrefixGroup input[type=radio]").forEach(r => r.checked = false);
    el.classList.add("selected");
    el.querySelector("input[type=radio]").checked = true;
    const field = document.getElementById("customPrefixField");
    if (enabled) {
        field.classList.add("show");
    } else {
        field.classList.remove("show");
    }
}

function toggleWorldPrefix(enabled, el) {
    document.querySelectorAll("#worldPrefixGroup .radio-option").forEach(o => o.classList.remove("selected"));
    document.querySelectorAll("#worldPrefixGroup input[type=radio]").forEach(r => r.checked = false);
    el.classList.add("selected");
    el.querySelector("input[type=radio]").checked = true;
    const field = document.getElementById("worldPrefixField");
    if (enabled) {
        field.classList.add("show");
    } else {
        field.classList.remove("show");
    }
}

/* ================= 创建世界 ================= */
async function generateWorld() {
    const name = document.getElementById("worldName").value.trim();
    const type = document.getElementById("worldType").value;
    const desc = document.getElementById("worldDesc").value.trim();
    const hero = ""; // 主角设定已移至世界详情弹窗（进入世界前填写），创建阶段不收集
    const ipName = type === "ip" ? document.getElementById("ipName").value.trim() : "";
    const styleRef = getSelectedStyleRef();
    const customStyle = styleRef === "custom" ? document.getElementById("customStyle").value.trim() : "";
    const rulesetType = selectedRuleset || 'dnd';
    const ruleFreedom = parseInt(document.getElementById("ruleFreedom").value);
    const worldFreedom = parseInt(document.getElementById("worldFreedom").value);
    // 预言机 / 混沌因子：创建时选择是否启用 + 强度（1-9）
    const oracleEnabledEl = document.getElementById("oracleEnabled");
    const chaosFactorEl = document.getElementById("chaosFactor");
    const oracleConfig = {
        enabled: oracleEnabledEl ? oracleEnabledEl.checked : true,
        chaos_factor: chaosFactorEl ? (parseInt(chaosFactorEl.value) || 5) : 5
    };
    // 战争迷雾：创建时选择是否启用
    const fogOfWarEl = document.getElementById("fogOfWar");
    const fogOfWar = fogOfWarEl ? fogOfWarEl.checked : true;
    const prefixEnabled = document.querySelector("input[name='customPrefixEnable']:checked");
    const customPrefix = (prefixEnabled && prefixEnabled.value === "on") ? document.getElementById("customPrefix").value.trim() : "";
    const worldPrefixEnabled = document.querySelector("input[name='worldPrefixEnable']:checked");
    const worldPrefix = (worldPrefixEnabled && worldPrefixEnabled.value === "on") ? document.getElementById("worldPrefix").value.trim() : "";
    const narrativeAnchors = document.getElementById("narrativeAnchors") ? document.getElementById("narrativeAnchors").value.trim() : "";

    if (!name || !desc) {
        showToast("请填写世界名称和世界观描述", "error");
        return;
    }
    if (type === "ip" && !ipName) {
        showToast("基于已有 IP 时请填写作品名称", "error");
        return;
    }

    const btn = document.getElementById("generateWorldBtn");
    btn.disabled = true;
    btn.textContent = "生成中...";

    try {
        const generated = await callWorldGenerationLLM(name, type, desc, hero, ipName, sourceFileContent, styleRef, customStyle, rulesetType, ruleFreedom, worldFreedom, worldPrefix);
        // H) 基调显式持久化：优先用 AI 显式定调的 tone，否则降级为文本推断（兜底）
        const toneVal = normalizeTone(generated.tone) || inferToneFromWorld({ desc: desc, hero: hero, opening_narrative: generated.opening_narrative || "" });
        const world = {
            id: "w" + Date.now(),
            name,
            type,
            desc,
            hero,
            ip_name: ipName,
            createdAt: new Date().toISOString().split("T")[0],
            tags: analyzeWorldTags(name, desc, hero, type, ipName),
            tone: toneVal,
            schema: generated.schema || defaultWorldSchema(name + " " + desc),
            initial_state: generated.initial_state,
            lore_kb: generated.lore_kb,
            // E12：将上一段传说作为彩蛋注入知识库，并挂接引用
            inherited_legend: null,
            opening_narrative: generated.opening_narrative || "",
            initial_choices: generated.initial_choices || [],
            system_prompt: generated.system_prompt,
            behavior_records: narrativeAnchors ? [{ id: "b_anchor_" + (typeof genId === "function" ? genId("").slice(0, 12) : Date.now().toString(36)), text: "主角叙事锚点：" + narrativeAnchors, createdAt: new Date().toISOString() }] : [],
            pinned_facts: [],
        oracle: { enabled: true, chaos_factor: 5 },
            narrative_anchors: narrativeAnchors || (generated.initial_state && generated.initial_state.narrative_anchors) || "",
            source_content: sourceFileContent || "",
            style_ref: styleRef,
            custom_style: customStyle,
            ruleset_type: rulesetType,
            rule_freedom: ruleFreedom,
            world_freedom: worldFreedom,
            custom_prefix: customPrefix,
            oracle: oracleConfig,
            fog_of_war: fogOfWar
        };

        // A1: 为新建世界的知识片段补齐向量（与预计算向量同格式）
        await computeEmbeddingsForWorld(world);

        // F 跨周目 meta 成长：将上一段传说评级，作为「彩蛋 + 机制性馈赠」注入新世界
        if (pendingInheritedLegend) {
            const leg = pendingInheritedLegend;
            const payload = buildInheritedLegendPayload(leg);
            const legHeroName = leg.heroName || "一位无名旅人";
            const legendSnippet = Object.assign({ id: "b_legend_" + (typeof genId === "function" ? genId("").slice(0, 12) : Date.now().toString(36)) }, payload.loreSnippet);
            if (world.lore_kb && Array.isArray(world.lore_kb.snippets)) {
                world.lore_kb.snippets.push(legendSnippet);
            } else {
                world.lore_kb = { ip: world.name, snippets: [legendSnippet] };
            }
            world.inherited_legend = {
                id: leg.id,
                worldName: leg.worldName,
                heroName: leg.heroName,
                summary: leg.summary,
                tier: payload.tier,
                tierLabel: payload.tierLabel,
                score: payload.score,
                bonuses: payload.bonuses
            };
            // 机制性加成：写入 initial_state，新周目开局即生效
            if (world.initial_state) {
                world.initial_state = applyLegendBonusToInitialState(world.initial_state, leg);
            }
            pendingInheritedLegend = null;
            refreshInheritedLegendUI();
        }

        // 纯叙事模式：剥离战斗数值（保持叙事纯净）
        if (rulesetType === "narrative" && world.initial_state && world.initial_state.combat_stats) {
            delete world.initial_state.combat_stats;
        }

        worlds.unshift(world);
        saveWorlds();
        // 调试日志：记录世界创建
        debugLog.worldCreations.push({
            time: new Date().toISOString(),
            worldName: name,
            worldType: type,
            ipName: ipName || null,
            ruleFreedom: ruleFreedom,
            loreSnippets: world.lore_kb ? world.lore_kb.snippets.length : 0,
            openingTextLen: (world.opening_narrative || "").length
        });
        renderWorldList();

        document.getElementById("worldName").value = "";
        document.getElementById("worldDesc").value = "";
        document.getElementById("ipName").value = "";
        document.getElementById("customStyle").value = "";
        document.getElementById("customPrefix").value = "";
        // 重置特殊要求开关
        document.querySelectorAll("#customPrefixGroup .radio-option").forEach((o, i) => {
            o.classList.toggle("selected", i === 0);
        });
        document.querySelectorAll("#customPrefixGroup input[type=radio]").forEach((r, i) => {
            r.checked = i === 0;
        });
        document.getElementById("customPrefixField").classList.remove("show");
        clearSourceFile();
        closeModal("createWorldModal");

        // ★ CRPG: 角色创建（纯叙事模式跳过，无战斗数值/职业/种族）
        var latestWorld = worlds[0];
        if (rulesetType !== "narrative" && typeof CharacterCreatorUI !== "undefined" && CharacterCreator.isLoaded()) {
            showToast("世界已创建，请配置你的角色...", "success", 1500);
            setTimeout(function() {
                CharacterCreatorUI.show(function(result) {
                    // 注入 combat_stats 到世界初始状态
                    if (latestWorld.initial_state) {
                        latestWorld.initial_state.combat_stats = result.combatStats;
                        latestWorld.initial_state.race = result.race;
                        latestWorld.initial_state.class = result.class;
                    }
                    saveWorlds();
                    renderWorldList();
                    showToast("角色创建完成！", "success");
                });
            }, 500);
        } else {
            showToast("世界生成成功！", "success");
        }
    } catch (e) {
        let errorMsg = e.message;
        if (errorMsg.includes("Failed to fetch") || errorMsg.includes("NetworkError") || errorMsg.includes("failed to fetch")) {
            errorMsg = "网络请求失败（大概率是 CORS 跨域限制）。请在 API 配置中填写 CORS 代理 URL，或使用浏览器 CORS 插件。";
        }
        showToast("生成失败：" + errorMsg, "error");
        console.error(e);
    } finally {
        btn.disabled = false;
        btn.textContent = "确认生成";
    }
}

async function callWorldGenerationLLM(name, type, desc, hero, ipName, sourceContent, styleRef, customStyle, rulesetType, ruleFreedom, worldFreedom, worldPrefix) {
    const mock = document.getElementById("mockMode").checked;
    if (mock) {
        await sleep(1200);
        return mockGenerateWorld(name, type, desc, hero, ipName);
    }

    const baseUrl = document.getElementById("baseUrl").value.trim();
    const corsProxy = document.getElementById("corsProxy").value.trim();
    const apiKey = document.getElementById("apiKey").value.trim();
    const model = document.getElementById("modelName").value.trim();
    if (!baseUrl || !apiKey || !model) {
        throw new Error("请填写 Base URL、API Key 和模型名称，或开启模拟模式。");
    }

    const prompt = buildWorldGenerationPrompt(name, type, desc, hero, ipName, sourceContent, styleRef, customStyle, rulesetType, ruleFreedom, worldFreedom, worldPrefix, pendingInheritedLegend);
    const url = buildApiUrl(baseUrl, corsProxy);
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + apiKey
        },
        body: JSON.stringify({
            model,
            messages: [{ role: "system", content: prompt }],
            temperature: 0.7,
            response_format: { type: "json_object" }
        })
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("API 返回异常：无法获取响应内容");
    return parseResponse(content);
}

function buildWorldGenerationPrompt(name, type, desc, hero, ipName, sourceContent, styleRef, customStyle, rulesetType, ruleFreedom, worldFreedom, worldPrefix, inheritedLegend) {
    var worldFreedomDesc = {
        1: "严格遵循源材料：世界观设定、人物关系、核心事件必须与源材料保持一致，不得主观创作偏离源材料的内容。",
        2: "以源材料为锚：在世界观框架内发展剧情，关键设定保持不变，细节上可以有合理延伸。",
        3: "适中等散：参考世界观的框架设定，剧情和人物可在合理范围内创新和延伸。",
        4: "自由发挥：只保留世界观的核心设定和文化背景，剧情和人物关系由AI自由创作。",
        5: "完全自由：仅借用世界观的基本概念和氛围，一切剧情和设定由AI独立生成。"
    };

    var rulesetInfo = '';
    if (rulesetType === 'dnd') {
        rulesetInfo = '\n## 规则集\n当前使用 D&D 奇幻规则集。角色使用六属性(STR/DEX/CON/INT/WIS/CHA)，支持种族和职业选择，战斗使用 D20 回合制。请在初始状态和知识库中融入D&D风格的奇幻元素。';
    } else if (rulesetType === 'cthulhu') {
        rulesetInfo = '\n## 规则集\n当前使用克苏鲁恐怖规则集。角色使用理智/知识/意志/体能属性，侧重调查和生存而非战斗。请在初始状态和知识库中营造克苏鲁风格的压抑、未知和恐怖氛围。';
    } else if (rulesetType === 'scifi') {
        rulesetInfo = '\n## 规则集\n当前使用科幻规则集。角色使用技术/社交/战斗/感知属性，侧重科技辅助和星际探索。请在初始状态和知识库中体现未来科技感。';
    } else if (rulesetType === 'modern') {
        rulesetInfo = '\n## 规则集\n当前使用现代规则集。角色使用智力/魅力/体能/技术属性，侧重都市冒险和社会博弈。请在初始状态和知识库中体现现代都市氛围。';
    } else if (rulesetType === 'narrative') {
        rulesetInfo = '\n## 规则集\n当前使用纯叙事模式（AI 文字扮演冒险）。无骰子、无属性、无战斗系统、无 HP/MP/AC 数值，所有剧情由 AI 叙事驱动。\n- initial_state 中不要包含 combat_stats；attributes / relationships / skills 全部用文字描述。\n- 请专注于叙事质量、人物心理、关系演变与氛围描写，把玩家的"攻击/施法/休息"等输入理解为叙事意图而非掷骰。\n- 用 state_changes.reputation（声望/名号）和 state_changes.tension（危机张力）来体现成长与张力，替代数值升级；用 npc_states[].attitude 体现 NPC 好感变化；用 narrative_anchors 埋下主角的执念/秘密/禁忌，并让 NPC 在后续互动中适时引用。';
    } else if (rulesetType === 'ai') {
        rulesetInfo = '\n## 规则集\n当前使用「AI 生成规则」：请你根据世界观自动设计一套轻量且自洽的规则（属性维度、可用动作、是否使用骰子、战斗如何处理），并在 schema 与 initial_state 中体现。规则应服务于叙事，不要过度复杂。';
    }

    const styleRefDesc = {
        original: "请参考源文件的文风和叙事节奏进行生成。",
        custom: customStyle ? `请严格遵循以下文风进行生成：${customStyle}` : "请使用通用叙事风格。",
        none: "请使用通用叙事风格，不需要模仿特定文风。"
    };

    const ipNameSection = (type === "ip" && ipName)
        ? `\n- 作品名称：${ipName}\n  请根据你对「${ipName}」这部作品的了解，从训练数据中检索其世界观设定、核心人物、力量体系、重要事件、叙事风格等要素，用于生成游戏配置。如果你对该作品不够了解，请在知识库中如实标注"信息不确定"。`
        : "";

    const sourceSection = sourceContent
        ? `\n# 源文件参考\n\n以下是用户上传的世界观/小说源文件内容（前 8000 字），请从中提取世界观设定、人物关系、力量体系、叙事风格等元素：\n\n\`\`\`\n${sourceContent.slice(0, 8000)}\n\`\`\`\n`
        : "";

    const lengthLimitSection = sourceContent
        ? `\n- 知识库至少生成 12 条，每条 100-300 字，确保覆盖源文件中的关键设定。`
        : `\n- 知识库至少生成 8 条，每条 100-300 字。`;

    const prefixSection = worldPrefix ? worldPrefix + "\n\n" : "";

    const legendSection = (inheritedLegend && inheritedLegend.summary)
        ? `\n# 跨周目传承彩蛋（前世传说）\n\n玩家选择带入了一段来自其他周目/世界的传说，请将其作为「世界背景中的古老传闻」自然地融入本次生成：\n- 传说概览：${inheritedLegend.summary}\n- 前世旅人姓名：「${inheritedLegend.heroName || "无名旅人"}」（这是 NPC 可能在对话中提及的名字）\n- 来源世界：${inheritedLegend.worldName}（传说主角名号：${inheritedLegend.reputationTitle || "未知"}）\n要求：\n1. 在 lore_kb 的「事件」或「冲突」类片段中，用 1 条隐晦地提及这段传闻（例如某个 NPC 提及、某本古籍记载、某处遗迹铭文），可以点出前世旅人的名字「${inheritedLegend.heroName || "无名旅人"}」，但不要喧宾夺主。\n2. 在 opening_narrative 里可若有若无地埋下呼应（如"据说很多年前，也曾有一位名为「${inheritedLegend.heroName || "某人"}」的旅人走过同样的路"），但不要让玩家立刻察觉这是前世。\n3. 不要改动本世界自身的核心设定来迎合这段传说。\n`
        : "";
    return prefixSection + `你是专业的文字游戏世界观设计师。请根据以下信息，为一个 AI 文字游戏生成完整的世界配置。

# 输入

- 世界名称：${name}
- 类型：${type === "ip" ? "基于已有 IP / 小说" : "原创世界观"}
- 世界观描述：${desc}
- 主角设定：${hero || "未指定，由你设计"}

**重要：主角设定描述的是角色当前已经具备的能力、身份、背景。这是已经成立的事实，不是"成长起点"。** 例如：
- 若主角设定为"催眠之王"，则 initial_state 中应体现其催眠能力已臻化境，relationships 中应包含因催眠能力建立的声望/人脉/敌人。**不得**将其设为"催眠初学者""刚接触催眠"。
- 若主角设定为"退隐江湖的剑圣"，则初始状态应反映其过去的威望、隐藏的实力、以及退隐后的生活状态。
- 若主角设定为"普通高中生"，则初始状态应是平凡但有日常生活细节的普通人。
${ipNameSection}
${sourceSection}
# 文风要求

${styleRefDesc[styleRef] || styleRefDesc.none}

# 自由度控制

${worldFreedomDesc[worldFreedom] || worldFreedomDesc[3]}
${rulesetInfo}

# 输出要求

请输出一个严格合法的 JSON，包含以下字段：

1. schema: 世界属性模板对象，包含：
   - progression_label: 进度系统显示名称，如"境界"/"年级"/"职业等级"
   - progression_path_label: 路线显示名称，如"修行路线"/"学院"/"职业分支"
   - has_skills: 该世界是否有技能系统（boolean）
   - skill_label: 技能显示名称，如"功法"/"课程"/"技能"
   - attribute_labels: 属性中文映射，键为 courage/perception/patience/luck/will，值为中文名
   - time_mode: "periods"（按时段推进）| "continuous"（自由时间描述，period填任意字符串）| "hidden"（不展示时间）
   - time_periods: 时间段映射，如 {"morning":"早晨", ...}（periods 模式必填，可自定义任意数量和名称）

2. initial_state: 玩家初始状态对象。**主角的初始能力/身份/技能必须如实反映主角设定中的描述**，不要将其降级为初学者。包含：
   - name, age, background, personality（数组）
   - attributes: {courage, perception, patience, luck, will}，每个值都是一段**文字描述**，不是数字。描述要体现玩家当前水准和世界观。
   - progression: {path, rank, progress}
   - relationships: {NPC名: "关系的文字描述"}
   - skills: {技能名: "技能的文字描述"}
   - inventory: [{item_id, name, count}]
   - completed_events: []
   - current_location: 初始地点
   - current_date: {day, period}
   - goals: [{goal_id, name, type, tier:"main"|"side"|"personal", deadline:{day,period}, progress:0, visible}]
   - status_effects: []
   - npc_states: {NPC名: {attitude: 数值(-100..100，初始对主角的好感，正数友好负数敌视), mood: "当前心情文字", schedule: {morning:"常去地点",night:"常去地点"}(按本世界时段填日常行程), secrets: ["该 NPC 隐瞒的事"], speech_style: "说话风格描述", catchphrase: "口头禅或标志性用语"}}。请为 lore_kb 中每个关键 NPC 都生成初始 npc_states。
   - reputation: 0（纯叙事/无数值世界的成长度量，替代属性升级；跑团世界可忽略）
   - tension: 0（世界当前的危机张力，0=平静，100=危如累卵）
   - narrative_anchors: {obsession:"主角的执念", secret:"主角隐藏的秘密", taboo:"主角不可触碰的禁忌"}（若主角设定里隐含，请据实填充；纯叙事模式尤其重要）
   - is_alive: true
   - death_reason: null

3. lore_kb: 知识库对象，包含：
   - ip: 世界名
   - snippets: 数组，每条包含 {id, category（必须覆盖以下类型：规则/地点/人物/事件/物品/势力/冲突）, title, content, keywords（数组）}

   各 category 要求：
   - 冲突（至少 2 条）：世界的核心矛盾与张力，谁和谁对立，为什么，玩家可能被卷入哪一方。示例：金玉良缘vs木石前盟、家族利益vs个人情感、正邪之争。
   - 事件（至少 2 条）：可触发的事件，每条需包含触发条件（时间+地点+可能的前置条件），以及事件内容和后果。
   - 人物片段中需附带该角色的**日常行程**（什么时间在什么地方）以及说话风格(speech_style)与口头禅(catchphrase)的简短描述
   ${lengthLimitSection}

4. system_prompt: 用于游戏运行时的 System Prompt 字符串，要包含世界观硬约束、叙事风格、输出格式说明。

5. opening_narrative: 开场白字符串（1-3段），用于玩家首次进入世界时的沉浸式叙事引入。要求：
   - 根据世界观、角色设定和文风，写出富有氛围感的开场场景描写
   - 让玩家立即感受到身处该世界，知晓自己的处境和初步目标
   - 结尾暗示玩家的第一个行动方向，但不要强制
   - 篇幅适中（200-500字），不要太短也不要太长

6. initial_choices: 开场选项数组（2-4个），每个选项包含 {text: "选项文本", hint: "简短提示"}，用于玩家首次进入时选择第一个行动。选项要符合世界观和角色设定，引导而非强制。

7. tone: 叙事基调对象，包含 {primary: "日常"|"高张力"|"悬疑"|"浪漫"|"混合", labels: [字符串数组，可包含多个维度如 ["日常","浪漫"]], description: "一句话描述本世界的叙事基调与氛围倾向"}。请基于世界观与主角设定**显式判定**本世界的叙事基调，不要笼统或回避；这是世界运行时 system prompt 的核心氛围设定，必须认真填写。

# 注意

${legendSection}
- 所有内容要符合该世界的力量体系，不要跨世界观混杂。
- ${type === "ip" ? "已有 IP 不要篡改不可改变的核心设定和关键角色命运。" : "原创世界请保持内部逻辑自洽。"}
- attributes / relationships / skills 全部使用文字描述，不要输出数字。
- 输出必须是合法 JSON，不要包含 markdown 代码块标记。`;
}

function mockGenerateWorld(name, type, desc, hero, ipName) {
    const isXianxia = /仙|侠|修|道|武|玄|魔/.test(name + desc);
    const isMagicSchool = /霍格沃茨|哈利|魔法|学院|巫师/.test(name + desc);

    let schema, initial_state, lore_snippets, system_prompt;

    if (isMagicSchool) {
        schema = {
            progression_label: "年级",
            progression_path_label: "学院",
            has_skills: true,
            skill_label: "课程/法术",
            attribute_labels: { courage: "勇气", perception: "观察", patience: "耐心", luck: "运气", will: "意志" },
            time_periods: DEFAULT_PERIOD_LABELS,
            game_over_conditions: ["is_alive === false"]
        };
        initial_state = {
            name: "新生",
            age: 11,
            background: "刚刚收到入学通知书，对魔法世界一无所知。",
            personality: ["好奇", "紧张"],
            attributes: {
                courage: "勇气不算出众，但分院帽似乎从你身上嗅到了某种执拗。",
                perception: "观察力不算敏锐，但偶尔能注意到别人遗漏的魔法细节。",
                patience: "坐得住魔药课漫长的准备步骤，可一旦出错就忍不住想摔坩埚。",
                luck: "命运似乎在你看不见的地方悄悄转动。",
                will: "年纪虽小，却有着一股不愿轻易认输的倔劲。"
            },
            progression: { path: "待定", rank: "一年级新生", progress: 0 },
            relationships: {
                "分院帽": "素未谋面，只听说它会在你头上做出决定。",
                "室友": "尚未谋面。",
                "魔药课教授": "只在别人口中听说过，名声让人既敬畏又紧张。"
            },
            skills: {
                "魔药学": "连药材名字都记不全，更别提调配。",
                "变形术": "理论上知道物体可以变形，实际上连火柴都没让变尖过。",
                "飞行": "从没骑过扫帚，光是想象离地就已经手心冒汗。"
            },
            inventory: [{ item_id: "wand", name: "魔杖", count: 1 }, { item_id: "robe", name: "校袍", count: 1 }],
            completed_events: [],
            current_location: "学院大厅",
            current_date: { day: 1, period: "morning" },
            goals: [
                { goal_id: "sorted", name: "完成分院仪式", type: "完成事件", deadline: { day: 1, period: "night" }, visible: true },
                { goal_id: "first_class", name: "上完第一堂课", type: "完成事件", deadline: { day: 2, period: "night" }, visible: true }
            ],
            status_effects: [],
            is_alive: true,
            death_reason: null
        };
        lore_snippets = [
            { id: "m1", category: "规则", title: "魔法世界规则", content: "巫师需使用魔杖施法，未成年人禁止在校外施法。", keywords: ["魔杖", "施法", "规则"] },
            { id: "m2", category: "地点", title: "学院大厅", content: "新生入学与分院仪式举行之地，穹顶施有天气咒。", keywords: ["大厅", "分院"] },
            { id: "m3", category: "人物", title: "分院帽", content: "一顶有自我意识的魔法帽，负责为新生分配学院。", keywords: ["分院帽"] }
        ];
        system_prompt = `你是${name}魔法学院背景文字游戏的主持人。规则：符合魔法世界观，一年级新生不能施展高级咒语，不可篡改原著核心事件。输出 JSON。`;
    } else if (isXianxia) {
        schema = {
            progression_label: "境界",
            progression_path_label: "修行路线",
            has_skills: true,
            skill_label: "功法/技艺",
            attribute_labels: { courage: "胆识", perception: "洞察", patience: "耐心", luck: "气运", will: "心志" },
            time_periods: DEFAULT_PERIOD_LABELS,
            game_over_conditions: ["is_alive === false"]
        };
        initial_state = {
            name: "少年",
            age: 16,
            background: "小镇出身的少年，机缘巧合踏上修行路。",
            personality: ["谨慎", "坚韧"],
            attributes: {
                courage: "道心初立，面对修士威压仍会紧张，但已敢抬头看对方的眼睛。",
                perception: "能留意到灵气波动的微弱痕迹，却常常分辨不出真假。",
                patience: "能忍着打坐一个时辰，再多腿就开始发麻。",
                luck: "不算好也不算坏，偶尔能在路边捡到半块灵石。",
                will: "心志尚浅，却被生活磨出了一股不服输的韧劲。"
            },
            progression: { path: "未入门", rank: "凡人", progress: 0 },
            relationships: {
                "老道长": "萍水相逢，他看你的眼神里带着几分打量。",
                "同乡少年": "你们彼此看不顺眼，言语间多有试探。",
                "药铺掌柜": "只是点头之交，谈不上熟悉。"
            },
            skills: {
                "剑术": "只会些庄稼把式，连剑都握不太稳。",
                "打坐": "才学会吐纳的皮毛，坐久了腿麻。",
                "辨识草药": "只认得出最常见的几种，常把杂草当宝贝。"
            },
            inventory: [{ item_id: "bread", name: "干粮", count: 2 }, { item_id: "coin", name: "铜钱", count: 10 }],
            completed_events: [],
            current_location: "小镇入口",
            current_date: { day: 1, period: "morning" },
            goals: [
                { goal_id: "find_shelter", name: "找到落脚之处", type: "完成事件", deadline: { day: 1, period: "night" }, visible: true },
                { goal_id: "meet_someone", name: "认识一位当地人", type: "关系变化", deadline: { day: 3, period: "night" }, visible: true }
            ],
            status_effects: [],
            is_alive: true,
            death_reason: null
        };
        lore_snippets = [
            { id: "x1", category: "规则", title: "修行境界", content: "凡人、练气、筑基、金丹、元婴……境界不可跳跃。", keywords: ["境界", "修行"] },
            { id: "x2", category: "地点", title: "小镇", content: "大千世界边缘的小镇，鱼龙混杂，是修行者的落脚点。", keywords: ["小镇"] },
            { id: "x3", category: "人物", title: "老道长", content: "隐居小镇的落魄修士，看似普通，实则见识广博。", keywords: ["老道长"] }
        ];
        system_prompt = `你是${name}仙侠背景文字游戏的主持人。规则：境界不可跳跃，重大事件不可篡改，NPC不会无条件帮助玩家。输出 JSON。`;
    } else {
        schema = defaultWorldSchema(name + " " + desc);
        initial_state = {
            name: "旅人",
            age: 18,
            background: "从远方而来的旅人，对这个新世界充满好奇。",
            personality: ["谨慎", "好奇"],
            attributes: {
                courage: "初来乍到，遇事不免有些畏缩，但还不到仓皇逃窜的地步。",
                perception: "对周遭动静还算留心，偶尔会注意到旁人忽略的细节。",
                patience: "能坐得住一时半刻，但若长久无望，也会焦躁起来。",
                luck: "不好不坏，像被世界随手一扔的普通石子。",
                will: "心志尚浅，却还没被现实完全磨平。"
            },
            progression: { path: "无", rank: "新手", progress: 0 },
            relationships: {
                "向导": "萍水相逢，对方看你的眼神里带着几分打量。",
                "酒馆老板": "只是点头之交，谈不上熟悉。"
            },
            skills: {
                "交涉": "说话还算有条理，但远未到打动人心的地步。",
                "观察": "能注意到一些明显迹象，深层的线索却常常错过。"
            },
            inventory: [{ item_id: "bread", name: "干粮", count: 2 }, { item_id: "coin", name: "铜币", count: 10 }],
            completed_events: [],
            current_location: "边境驿站",
            current_date: { day: 1, period: "morning" },
            goals: [
                { goal_id: "find_shelter", name: "找到落脚之处", type: "完成事件", deadline: { day: 1, period: "night" }, visible: true }
            ],
            status_effects: [],
            is_alive: true,
            death_reason: null
        };
        lore_snippets = [
            { id: "g1", category: "规则", title: "世界规则", content: desc.slice(0, 120), keywords: ["规则"] },
            { id: "g2", category: "地点", title: "初始地点", content: "玩家旅程开始的地方。", keywords: ["地点"] }
        ];
        system_prompt = `你是${name}背景文字游戏的主持人。世界观：${desc}。规则：符合世界观，不可让玩家轻易获得超规格力量。输出 JSON。`;
    }

    // 开场白
    let opening_narrative = "";
    if (isMagicSchool) {
        opening_narrative = `九月的夜风裹着凉意吹过城堡的石墙。你站在宏伟的大厅门口，手里攥着那封改变一切的录取通知书，周围是和你一样忐忑的新生。穹顶上方，烛火漂浮在半空中，像无数不肯坠落的星辰。远处，长桌尽头坐着几位面容严肃的长者，而最引人注目的，是那顶安安静静搁在椅子上的旧帽子——据说它会决定你未来七年的命运。\n\n分院仪式即将开始。你听见身旁有人小声嘀咕，有人在深呼吸，有人在偷瞄高年级学生的表情。你呢？你的手心微微出汗，心跳声在安静的厅堂里似乎格外清晰。`;
    } else if (isXianxia) {
        opening_narrative = `晨雾尚未散尽，小镇的街巷还笼罩在一层薄薄的灰白里。你背着半旧包袱，踩着湿漉漉的石板路朝镇口走去。路旁的早市摊子刚刚支起来，卖豆腐的老妪朝你点了点头，药铺的门半掩着，里头传来捣药杵沉闷的声响。\n\n你不知道自己要往哪儿去，只知道不能再留在这个地方了。昨夜你在后山看见了不该看见的东西——一道光从崖壁裂缝中渗出来，转瞬即逝，却像一根鱼刺卡在喉咙里，让你整宿没合眼。镇上的人说那座山有古怪，可谁也说不清古怪在哪里。\n\n此刻你站在镇口的岔路前，一条通往山脚，一条通往更远的官道。你的心跳比平时快了一些，呼吸也深了几寸。这不是恐惧——你比恐惧还差一点——是某种尚未说出口的期待。`;
    } else {
        opening_narrative = `你从漫长的昏睡中醒来，发现自己躺在一间陌生的房间里。窗外透进来的光线带着你不熟悉的色调——偏暖、偏沉，像是某个你从未到过的地方的傍晚。空气中有一股若有若无的气味，说不上是好闻还是难闻，只是和记忆里所有已知的气味都不一样。\n\n你坐起身来，四处打量。桌上放着一张字条，上面写着你的名字和一句话：「你来的时间比预期的早了半天，先去楼下看看吧。」\n\n你不知道写下这行字的人是谁，也不清楚"预期"指的是什么。但直觉告诉你，此刻走出去或许比留在原地更安全——或者说，更有趣。`;
    }

    let tone;
    if (isMagicSchool) {
        tone = { primary: "日常", labels: ["日常", "浪漫"], description: "轻松中藏着魔法校园的奇妙与少年成长。" };
    } else if (isXianxia) {
        tone = { primary: "高张力", labels: ["高张力", "浪漫"], description: "修仙之路危机与机缘并存，恩怨如影随形。" };
    } else {
        tone = { primary: "日常", labels: ["日常"], description: "未知的旅程，节奏由探索者自己把握。" };
    }

    return {
        schema,
        initial_state,
        lore_kb: { ip: name, snippets: lore_snippets },
        system_prompt,
        opening_narrative,
        tone
    };
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function showWorldList() {
    renderWorldList();
    showScreen("worldListScreen");
}

function showSaveList() {
    renderSaveList();
    showScreen("saveListScreen");
}

function renderWorldList() {
    const container = document.getElementById("worldListContent");
    if (!worlds.length) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="text">还没有世界<br>点击上方按钮创建一个吧</div>
            </div>`;
        return;
    }
    // 按创建时间降序排列（最新的在最上面）
    const sorted = [...worlds].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const now = Date.now();
    const newThreshold = 24 * 60 * 60 * 1000;

    // 只给最新创建且 24 小时内的世界加「新」徽章
    let newestTime = 0;
    if (sorted.length > 0) newestTime = new Date(sorted[0].createdAt).getTime();
    const newestId = (now - newestTime) < newThreshold ? sorted[0].id : null;

    container.innerHTML = sorted.map((w, i) => {
        const isNew = w.id === newestId;
        const delay = i * 0.07;
        const typeClass = w.type === 'ip' ? 'type-ip' : 'type-original';
        return `
        <div class="world-card${isNew ? ' new-world' : ''}" onclick="showWorldDetail('${w.id}')" style="animation: fadeSlideIn 0.4s ease-out ${delay}s both;">
            <div class="wc-header">
                <span class="wc-name">${w.name}${isNew ? '<span class="new-badge">新</span>' : ''}</span>
                <span class="wc-type ${typeClass}">${w.type === 'ip' ? 'IP' : '原创'}</span>
            </div>
            <div class="wc-desc">${w.desc || '暂无描述'}</div>
            <div class="wc-tags">
                ${(w.tone ? `<span class="tag tone">${w.tone.primary}</span>` : "")}
                ${(w.tags || []).map(t => `<span class="tag">${t}</span>`).join('')}
            </div>
            <div class="wc-actions" onclick="event.stopPropagation()">
                <button class="wc-delete" onclick="deleteWorld('${w.id}')" title="删除">删除</button>
            </div>
        </div>`;
    }).join("");
}

function renderSaveList() {
    const container = document.getElementById("saveListContent");
    if (!saves.length) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="text">还没有存档<br>进入世界开始游玩后自动生成</div>
            </div>`;
        return;
    }
    container.innerHTML = saves.map(s => {
        const isDead = s.state && s.state.is_alive === false;
        return `
        <div class="list-item save-item${isDead ? " dead-save" : ""}">
            <div class="save-info">
                <div class="item-title">${s.worldName}${isDead ? ' <span class="dead-badge">&#x2620; 已死亡</span>' : ""}</div>
                <div class="item-meta">${s.progress}<br>最后游玩：${s.updatedAt}</div>
                ${s.hero ? `<div class="item-hero">主角：${escapeHtml(s.hero.length > 40 ? s.hero.slice(0, 40) + "…" : s.hero)}</div>` : ""}
            </div>
            <div class="save-actions">
                <button class="save-play-btn" onclick="loadSave('${s.id}')">继续游玩</button>
                <button class="save-del-btn" onclick="deleteSave('${s.id}')">删除</button>
            </div>
        </div>
    `}).join("");
}

// 激活顶部「场景展示」面板：实时呈现当前地点 / 时段 / 氛围 / 世界脉搏 / 相关人物
function renderScenePanel() {
    const panel = document.getElementById("scenePanel");
    if (!panel || !gameState) return;
    const loc = gameState.current_location || (currentWorld && currentWorld.opening_narrative ? "初始之地" : "此处");
    const period = (gameState.current_date && gameState.current_date.period) || "day";
    const day = (gameState.current_date && gameState.current_date.day) || 1;
    const periodLabel = (typeof DEFAULT_PERIOD_LABELS !== "undefined" && DEFAULT_PERIOD_LABELS[period]) ? DEFAULT_PERIOD_LABELS[period] : period;
    let ambience = "";
    try { ambience = (typeof buildAmbienceHint === "function") ? buildAmbienceHint(loc, period, currentWorld) : ""; } catch (e) { ambience = ""; }
    const events = (currentWorld && currentWorld.current_world_events) || [];
    const latestPulse = events.length ? events[events.length - 1] : null;
    const rels = gameState.relationships || {};
    const npcNames = Object.keys(rels).slice(0, 2);
    panel.innerHTML = `
        <div class="scene-card">
            <div class="scene-head">
                <span class="scene-loc">📍 ${escapeHtml(loc)}</span>
                <span class="scene-time">第${day}天 · ${escapeHtml(String(periodLabel))}</span>
            </div>
            ${ambience ? `<div class="scene-amb">${escapeHtml(ambience)}</div>` : ""}
            ${latestPulse ? `<div class="scene-pulse">📣 ${escapeHtml(latestPulse.text)}</div>` : ""}
            ${npcNames.length ? `<div class="scene-npc">同行 / 相关：${npcNames.map(function(n){return escapeHtml(n);}).join("、")}</div>` : ""}
        </div>`;
    panel.style.display = "";
    updateTopPanelPlaceholder();
}

/* ================= 一键导入 IP 设定 ================= */
/**
 * 确保当前世界可编辑：若为预设世界（preset=true，system_prompt 含写死 canon），
 * 则先派生一个可编辑副本，避免污染原 canon。返回是否刚刚派生了副本。
 */
function ensureEditableWorld() {
    if (!currentWorld) return false;
    if (currentWorld.preset === true) {
        const copy = deepClone(currentWorld);
        copy.preset = false;
        copy.id = "copy_" + currentWorld.id + "_" + (typeof genId === "function" ? genId("").slice(0, 10) : Date.now().toString(36));
        copy.name = currentWorld.name + "（可编辑副本）";
        copy.createdAt = new Date().toISOString().split("T")[0];
        copy.imported_lore = true;
        worlds.push(copy);
        saveWorlds();
        currentWorld = copy;
        showToast("已复制为可编辑副本，导入将作用于副本（预设原文不受影响）", "success", 3000);
        return true;
    }
    return false;
}

function openImportLoreModal() {
    if (!currentWorld) return;
    const ta = document.getElementById("importLoreText");
    if (ta) ta.value = "";
    const prev = document.getElementById("importLorePreview");
    if (prev) prev.innerHTML = "";
    const status = document.getElementById("importLoreStatus");
    if (status) { status.textContent = ""; status.style.display = "none"; }
    const btn = document.getElementById("confirmImportLoreBtn");
    if (btn) { btn.style.display = "none"; btn.textContent = "确认导入"; }
    const nameEl = document.getElementById("importLoreWorldName");
    if (nameEl) nameEl.textContent = currentWorld.name;
    // 重置选项为默认值
    const m = document.querySelector('input[name="loreMode"][value="append"]');
    if (m) m.checked = true;
    const c = document.querySelector('input[name="loreCopyright"][value="safe"]');
    if (c) c.checked = true;
    updateLoreCopyrightHint();
    window.__pendingImportSnips = null;
    showModal("importLoreModal");
}

// 根据版权 radio 切换提示文案与颜色
function updateLoreCopyrightHint() {
    const el = document.querySelector('input[name="loreCopyright"]:checked');
    const hint = document.getElementById("loreCopyrightHint");
    if (!hint) return;
    if (el && el.value === "copyrighted") {
        hint.textContent = "受版权 IP：导入的知识仅限本机自用，请勿分享、导出或存为可分享预设。";
        hint.style.color = "#c0392b";
    } else {
        hint.textContent = "公版 IP 或原创设定可分享给他人；预设库仅收录此类。";
        hint.style.color = "";
    }
}

async function runExtractLore() {
    const ta = document.getElementById("importLoreText");
    const text = ta ? ta.value.trim() : "";
    if (!text) { showToast("请先粘贴原著/世界观文本", "error"); return; }
    const status = document.getElementById("importLoreStatus");
    const btn = document.getElementById("confirmImportLoreBtn");
    const preview = document.getElementById("importLorePreview");
    if (btn) btn.style.display = "none";
    if (status) { status.textContent = "正在抽取设定..."; status.style.display = ""; }
    try {
        const snips = await extractLoreFromText(text, currentWorld.name);
        if (!Array.isArray(snips) || snips.length === 0) {
            if (status) status.textContent = "未抽取到有效片段，请检查文本或模型配置。";
            return;
        }
        if (preview) {
            preview.innerHTML = snips.map(function (s) {
                const c = (s.content || "");
                return '<div class="lore-prev-item"><span class="lore-prev-cat">' + escapeHtml(s.category || "设定") + '</span> <b>' + escapeHtml(s.title || "未命名") + '</b>'
                    + '<div class="lore-prev-content">' + escapeHtml(c.slice(0, 120)) + (c.length > 120 ? "…" : "") + '</div></div>';
            }).join("");
        }
        if (status) status.textContent = "抽取到 " + snips.length + " 条片段，确认后导入到知识库。";
        window.__pendingImportSnips = snips;
        if (btn) { btn.style.display = ""; btn.textContent = "确认导入 " + snips.length + " 条"; }
    } catch (e) {
        if (status) status.textContent = "抽取失败：" + e.message;
    }
}

async function confirmImportLore() {
    const snips = window.__pendingImportSnips;
    if (!snips || !snips.length) { showToast("没有可导入的片段", "error"); return; }
    const derived = ensureEditableWorld();
    if (!currentWorld.lore_kb) currentWorld.lore_kb = { ip: currentWorld.name, snippets: [] };
    if (!Array.isArray(currentWorld.lore_kb.snippets)) currentWorld.lore_kb.snippets = [];

    // 读取导入模式：追加去重 / 覆盖同类 / 完全覆盖
    const modeEl = document.querySelector('input[name="loreMode"]:checked');
    const mode = modeEl ? modeEl.value : "append";
    let merged;
    if (mode === "overwrite") {
        merged = overwriteLoreSnippets(snips);
    } else if (mode === "category") {
        merged = replaceLoreByCategory(currentWorld.lore_kb.snippets, snips);
    } else {
        merged = mergeLoreSnippets(currentWorld.lore_kb.snippets, snips);
    }
    currentWorld.lore_kb.snippets = merged;
    if (!currentWorld.lore_kb.ip) currentWorld.lore_kb.ip = currentWorld.name;

    // 读取版权状态：safe（可分享）/ copyrighted（仅本地自用）
    const crEl = document.querySelector('input[name="loreCopyright"]:checked');
    const cr = crEl ? crEl.value : "safe";
    currentWorld.lore_copyright = cr;
    currentWorld.local_only = (cr === "copyrighted");

    currentWorld.imported_lore = true;
    saveWorlds();
    if (typeof computeEmbeddingsForWorld === "function") {
        try { await computeEmbeddingsForWorld(currentWorld); saveWorlds(); }
        catch (e) { console.warn("embedding 重算失败(可忽略):", e.message); }
    }
    const crTip = (cr === "copyrighted") ? "（受版权·仅本地自用）" : "";
    showToast("已导入 " + snips.length + " 条设定到知识库" + (derived ? "（副本）" : "") + crTip, "success", 3000);
    window.__pendingImportSnips = null;
    closeModal("importLoreModal");
}

/* ================= 玩家世界书：手动策展 lore / 常量记忆 ================= */
function openWorldBookModal() {
    if (!currentWorld) return;
    ensureEditableWorld(); // 预设世界自动派生副本，防止污染写死 canon
    const nm = document.getElementById("worldBookName");
    if (nm) nm.textContent = currentWorld.name;
    window.__wbEdit = null;
    renderWorldBook();
    showModal("worldBookModal");
}

/* ================= D 分支快照（多时间线存档）UI ================= */
function openSnapshotModal() {
    if (!currentWorld) { showToast("请先进入一个世界", "error"); return; }
    const nm = document.getElementById("snapshotWorldName");
    if (nm) nm.textContent = currentWorld.name;
    const inp = document.getElementById("snapshotLabelInput");
    if (inp) inp.value = "";
    renderSnapshots();
    showModal("snapshotModal");
}

function renderSnapshots() {
    const list = document.getElementById("snapshotList");
    if (!list) return;
    const mine = getSnapshotsForWorld(snapshots, currentWorld ? currentWorld.id : null);
    if (!mine.length) {
        list.innerHTML = '<div class="empty-hint">还没有任何分支快照。在关键抉择前拍一张，之后可随时回到此处「分叉」出不同时间线。</div>';
        return;
    }
    list.innerHTML = mine.map(function (s) {
        const t = (s.createdAt ? new Date(s.createdAt) : new Date()).toLocaleString("zh-CN", { hour12: false });
        const prog = s.progress ? ' · ' + escapeHtml(s.progress) : '';
        return '<div class="status-card" style="margin-bottom:10px;">' +
            '<div class="row"><span class="label">' + escapeHtml(s.label) + '</span></div>' +
            '<div class="text-block" style="font-size:11px;color:var(--text-muted)">' + t + prog + '</div>' +
            '<div style="margin-top:8px;display:flex;gap:8px;">' +
            '<button class="btn primary tiny" onclick="doLoadSnapshot(\'' + s.id.replace(/'/g, "\\'") + '\')">载入此分支</button>' +
            '<button class="btn ghost tiny" onclick="doDeleteSnapshot(\'' + s.id.replace(/'/g, "\\'") + '\')">删除</button>' +
            '</div></div>';
    }).join("");
}

/* ================= E 项：导出故事 ================= */
function openExportModal() {
    if (!currentWorld) { showToast("请先进入一个世界", "error"); return; }
    const md = buildStoryExport(currentWorld, gameState || {}, conversationHistory, chatSummary || [], {});
    window.__exportMarkdown = md;
    const ta = document.getElementById("exportPreview");
    if (ta) ta.value = md;
    const nm = document.getElementById("exportWorldName");
    if (nm) nm.textContent = currentWorld.name;
    const cnt = document.getElementById("exportWordCount");
    if (cnt) cnt.textContent = (md.length || 0) + " 字";
    showModal("exportStoryModal");
}

function doExportDownload() {
    const md = window.__exportMarkdown || "";
    if (!md) { showToast("没有可导出的内容", "error"); return; }
    const name = (currentWorld && currentWorld.name ? currentWorld.name : "story").replace(/[\\/:*?"<>|]/g, "_");
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name + "_冒险纪事.md";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    showToast("已下载 Markdown 文件", "success");
}

function doExportCopy() {
    const md = window.__exportMarkdown || "";
    if (!md) { showToast("没有可复制的内容", "error"); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(md).then(function () { showToast("已复制到剪贴板", "success"); }, function () { fallbackCopy(md); });
    } else {
        fallbackCopy(md);
    }
}

function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); showToast("已复制到剪贴板", "success"); }
    catch (e) { showToast("复制失败，请手动选择", "error"); }
    document.body.removeChild(ta);
}

function doTakeSnapshot() {
    if (!currentWorld || !gameState) return;
    const inp = document.getElementById("snapshotLabelInput");
    const label = inp ? inp.value.trim() : "";
    const progress = "第 " + (gameState.current_date ? gameState.current_date.day : 1) + " 天 · " +
        getPeriodLabel(gameState.current_date ? gameState.current_date.period : "day");
    snapshots = takeSnapshot(snapshots, currentWorld.id, currentWorld.name, {
        gameState: gameState,
        currentWorld: currentWorld,
        conversationHistory: conversationHistory,
        chatHistory: chatHistory,
        chatSummary: chatSummary
    }, { label: label, progress: progress });
    saveSnapshots();
    renderSnapshots();
    showToast("已拍摄分支快照" + (label ? "：" + label : ""), "success");
}

function doLoadSnapshot(id) {
    const snap = getSnapshotById(snapshots, id);
    if (!snap) { showToast("快照不存在", "error"); return; }
    const live = buildLiveStateFromSnapshot(snap);
    if (!live) return;
    gameState = live.gameState;
    // 用快照中的世界对象替换 worlds[] 内对应项，保持 currentWorld 引用一致
    const idx = worlds.findIndex(function (w) { return w.id === snap.worldId; });
    if (idx >= 0) worlds[idx] = live.currentWorld; else worlds.push(live.currentWorld);
    currentWorld = live.currentWorld;
    conversationHistory = live.conversationHistory;
    chatHistory = live.chatHistory;
    chatSummary = live.chatSummary;
    // 落盘：world（含快照中的商店/任务板/行为记录）+ 自动存档（从分叉点继续写）
    saveWorlds();
    if (typeof createOrUpdateSave === "function") createOrUpdateSave();
    closeModal("snapshotModal");
    // 重建叙事面板与世界/状态面板，呈现分叉后的时间线
    renderLog(true);
    renderStatusPanel(currentStatusTab);
    showToast("已载入分支：" + snap.label, "success");
}

function doDeleteSnapshot(id) {
    snapshots = deleteSnapshot(snapshots, id);
    saveSnapshots();
    renderSnapshots();
    showToast("已删除该分支快照", "info");
}

function renderWorldBook() {
    const loreList = document.getElementById("wbLoreList");
    const factList = document.getElementById("wbFactList");
    if (loreList) loreList.innerHTML = renderWbLoreList();
    if (factList) factList.innerHTML = renderWbFactList();
}

function renderWbLoreList() {
    const snips = (currentWorld.lore_kb && currentWorld.lore_kb.snippets) || [];
    if (!snips.length) return '<div class="empty-hint">还没有知识片段，点「＋ 新增片段」添加。</div>';
    return snips.map(function (s) {
        const id = s.id;
        return '<div class="status-card">'
            + '<div style="display:flex;align-items:center;"><span class="lore-prev-cat">' + escapeHtml(s.category || "设定") + '</span> <b>' + escapeHtml(s.title || "未命名") + '</b>'
            + '<span style="margin-left:auto;"><button class="btn ghost tiny" onclick="wbEditLore(\'' + id + '\')">编辑</button> '
            + '<button class="btn ghost tiny" onclick="wbDeleteLore(\'' + id + '\')">删除</button></span></div>'
            + '<div class="text-block" style="font-size:12px;color:var(--text-muted);">' + escapeHtml((s.content || "").slice(0, 160)) + ((s.content || "").length > 160 ? "…" : "") + '</div>'
            + (s.keywords && s.keywords.length ? '<div class="wb-kw">关键词：' + s.keywords.map(function (k) { return escapeHtml(k); }).join(" · ") + '</div>' : '')
            + '</div>';
    }).join("");
}

function renderWbFactList() {
    const facts = (currentWorld.pinned_facts || []).filter(function (p) { return p.status !== "resolved"; });
    if (!facts.length) return '<div class="empty-hint">还没有常量记忆，点「＋ 新增事实」添加（如「主角的剑永不锈蚀」）。</div>';
    return facts.map(function (p) {
        const src = p.source === "ai" ? "AI 标注" : p.source === "state" ? "状态信号" : "手动";
        return '<div class="status-card">'
            + '<div style="display:flex;align-items:center;"><span class="text-block" style="flex:1;margin:0;">' + escapeHtml(p.text) + '</span>'
            + '<span style="margin-left:8px;"><button class="btn ghost tiny" onclick="wbEditFact(\'' + p.id + '\')">编辑</button> '
            + '<button class="btn ghost tiny" onclick="wbDeleteFact(\'' + p.id + '\')">删除</button></span></div>'
            + '<div class="text-block" style="font-size:11px;color:var(--text-muted);">来源：' + src + '</div>'
            + '</div>';
    }).join("");
}

function wbNewLore() { window.__wbEdit = { type: "lore" }; showWbEditor(); }
function wbEditLore(id) { window.__wbEdit = { type: "lore", id: id }; showWbEditor(); }
function wbNewFact() { window.__wbEdit = { type: "fact" }; showWbEditor(); }
function wbEditFact(id) { window.__wbEdit = { type: "fact", id: id }; showWbEditor(); }

function showWbEditor() {
    const box = document.getElementById("wbEditor");
    if (!box) return;
    const ed = window.__wbEdit || {};
    let html = '';
    if (ed.type === "lore") {
        const s = ed.id ? (currentWorld.lore_kb.snippets || []).find(function (x) { return x.id === ed.id; }) : null;
        const CATS = ["背景", "事件", "人物", "势力", "冲突", "规则", "地点", "物品", "原文", "设定"];
        html = '<div class="wb-form">'
            + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
            + '<label style="font-size:12px;">分类<br><select id="wbCat">' + CATS.map(function (c) { return '<option' + (s && s.category === c ? ' selected' : '') + '>' + c + '</option>'; }).join("") + '</select></label>'
            + '<label style="font-size:12px;flex:1;min-width:200px;">标题<br><input id="wbTitle" style="width:100%;box-sizing:border-box;" value="' + escapeHtml(s ? s.title : '') + '"></label>'
            + '</div>'
            + '<label style="font-size:12px;display:block;margin-top:6px;">内容（100-300 字）<br><textarea id="wbContent" style="width:100%;min-height:80px;box-sizing:border-box;">' + escapeHtml(s ? (s.content || '') : '') + '</textarea></label>'
            + '<label style="font-size:12px;display:block;margin-top:6px;">关键词（逗号/顿号分隔）<br><input id="wbKw" style="width:100%;box-sizing:border-box;" value="' + escapeHtml(s && s.keywords ? s.keywords.join(",") : '') + '"></label>'
            + '<div style="margin-top:8px;"><button class="btn primary tiny" onclick="wbSaveEditor()">保存</button> <button class="btn ghost tiny" onclick="wbCancelEditor()">取消</button></div>'
            + '</div>';
    } else if (ed.type === "fact") {
        const p = ed.id ? (currentWorld.pinned_facts || []).find(function (x) { return x.id === ed.id; }) : null;
        html = '<div class="wb-form">'
            + '<label style="font-size:12px;display:block;">常量事实（一句话铁律，永不褪色）<br><textarea id="wbFactText" style="width:100%;min-height:60px;box-sizing:border-box;">' + escapeHtml(p ? (p.text || '') : '') + '</textarea></label>'
            + '<div style="margin-top:8px;"><button class="btn primary tiny" onclick="wbSaveEditor()">保存</button> <button class="btn ghost tiny" onclick="wbCancelEditor()">取消</button></div>'
            + '</div>';
    }
    box.innerHTML = html;
    box.style.display = "block";
}

function wbCancelEditor() {
    window.__wbEdit = null;
    const box = document.getElementById("wbEditor");
    if (box) { box.style.display = "none"; box.innerHTML = ""; }
}

async function wbSaveEditor() {
    const ed = window.__wbEdit;
    if (!ed) return;
    if (ed.type === "lore") {
        const cat = (document.getElementById("wbCat") || {}).value || "设定";
        const title = (document.getElementById("wbTitle") || {}).value || "";
        const content = (document.getElementById("wbContent") || {}).value || "";
        const kwRaw = (document.getElementById("wbKw") || {}).value || "";
        if (!title.trim()) { showToast("标题不能为空", "error"); return; }
        const item = {
            category: cat,
            title: title.trim(),
            content: content.trim(),
            keywords: kwRaw.split(/[，,、\s]+/).filter(Boolean)
        };
        if (ed.id) {
            currentWorld.lore_kb.snippets = updateLoreSnippet(currentWorld.lore_kb.snippets, ed.id, item);
        } else {
            if (!currentWorld.lore_kb) currentWorld.lore_kb = { ip: currentWorld.name, snippets: [] };
            currentWorld.lore_kb.snippets = addLoreSnippet(currentWorld.lore_kb.snippets, item);
        }
        if (!currentWorld.lore_kb.ip) currentWorld.lore_kb.ip = currentWorld.name;
        currentWorld.manual_lore = true;
    } else if (ed.type === "fact") {
        const text = (document.getElementById("wbFactText") || {}).value || "";
        if (!text.trim()) { showToast("事实不能为空", "error"); return; }
        if (ed.id) {
            currentWorld.pinned_facts = upsertPinnedFact(currentWorld.pinned_facts, { id: ed.id, text: text.trim() });
        } else {
            currentWorld.pinned_facts = upsertPinnedFact(currentWorld.pinned_facts, { text: text.trim(), source: "manual" });
        }
        currentWorld.manual_fact = true;
    }
    saveWorlds();
    if (typeof computeEmbeddingsForWorld === "function") {
        try { await computeEmbeddingsForWorld(currentWorld); saveWorlds(); }
        catch (e) { console.warn("embedding 重算失败(可忽略):", e.message); }
    }
    wbCancelEditor();
    renderWorldBook();
    showToast("已保存世界书修改", "success", 2000);
}

function wbDeleteLore(id) {
    currentWorld.lore_kb.snippets = removeLoreSnippet(currentWorld.lore_kb.snippets, id);
    saveWorlds();
    renderWorldBook();
}

function wbDeleteFact(id) {
    currentWorld.pinned_facts = removePinnedFact(currentWorld.pinned_facts, id);
    saveWorlds();
    renderWorldBook();
}

function showWorldDetail(worldId) {
    currentWorld = worlds.find(w => w.id === worldId);
    if (!currentWorld) return;
    document.getElementById("detailWorldTitle").textContent = currentWorld.name;
    const schema = getWorldSchema(currentWorld);
    document.getElementById("detailWorldBody").innerHTML = `
        <div class="form-group">
            <label>世界类型</label>
            <p style="margin:0;font-size:15px;">${currentWorld.type === "ip" ? "基于已有 IP / 小说" : "原创世界观"}</p>
        </div>
        ${currentWorld.lore_copyright ? `
        <div class="form-group">
            <label>版权状态</label>
            <p style="margin:0;font-size:14px;${currentWorld.local_only ? "color:#c0392b;" : "color:#27ae60;"}">${currentWorld.local_only ? "受版权 IP · 仅限本地自用，请勿分享或导出" : "公版 / 原创 · 允许分享"}</p>
        </div>` : ""}
        ${currentWorld.ip_name ? `
        <div class="form-group">
            <label>作品名称</label>
            <p style="margin:0;font-size:15px;color:var(--primary);">${currentWorld.ip_name}</p>
        </div>` : ""}
        <div class="form-group">
            <label>世界观描述</label>
            <p style="margin:0;font-size:14px;line-height:1.6;color:var(--text-secondary);">${currentWorld.desc}</p>
        </div>
        <div class="form-group">
            <label>主角设定（进入世界前可填写 / 修改）</label>
            <textarea id="heroDescEdit" placeholder="例如：一名来自小镇的少年，性格谨慎，渴望变强；或留空由 AI 设计主角..." style="min-height:72px;">${escapeHtml(currentWorld.hero || "")}</textarea>
            <div class="hint">这里设定「你」在这个世界里的身份与背景。创建世界时无需填写，进入前在此补全即可；留空则交由 AI 设计主角。</div>
        </div>
        <div class="form-group">
            <label>进度系统</label>
            <p style="margin:0;font-size:14px;color:var(--text-secondary);">${schema.progression_path_label} / ${schema.progression_label}</p>
        </div>
        <div class="form-group">
            <label>创建时间</label>
            <p style="margin:0;font-size:14px;color:var(--text-secondary);">${currentWorld.createdAt}</p>
        </div>
        ${currentWorld.opening_narrative ? `
        <div class="form-group">
            <label>开场白预览</label>
            <p style="margin:0;font-size:14px;line-height:1.8;color:var(--text-secondary);white-space:pre-line;">${currentWorld.opening_narrative.slice(0, 200)}${currentWorld.opening_narrative.length > 200 ? "..." : ""}</p>
        </div>` : ""}
        ${currentWorld.style_ref ? `
        <div class="form-group">
            <label>文风参考</label>
            <p style="margin:0;font-size:14px;color:var(--text-secondary);">${currentWorld.style_ref === "original" ? "参考原版文风" : currentWorld.style_ref === "custom" ? "自定义文风：" + (currentWorld.custom_style || "未填写") : "不参考文风"}</p>
        </div>` : ""}
        ${currentWorld.ruleset_type ? `
        <div class="form-group">
            <label>规则集</label>
            <p style="margin:0;font-size:14px;color:var(--text-secondary);">${({"dnd":"D&D 奇幻","cthulhu":"克苏鲁恐怖","scifi":"科幻","modern":"现代","narrative":"纯叙事","ai":"AI 生成规则"})[currentWorld.ruleset_type] || currentWorld.ruleset_type}</p>
        </div>` : ""}
        ${currentWorld.world_freedom ? `
        <div class="form-group">
            <label>世界观自由度</label>
            <p style="margin:0;font-size:14px;color:var(--text-secondary);">${["", "严格遵循源材料", "以源材料为锚", "适中", "自由发挥", "完全自由"][currentWorld.world_freedom] || "适中"}</p>
        </div>` : ""}
        ${currentWorld.custom_prefix ? `
        <div class="form-group">
            <label>特殊要求</label>
            <p style="margin:0;font-size:14px;line-height:1.6;color:var(--text-secondary);">${escapeHtml(currentWorld.custom_prefix)}</p>
        </div>` : ""}
        ${currentWorld.tone ? `
        <div class="form-group">
            <label>叙事基调</label>
            <p style="margin:0;font-size:14px;color:var(--text-secondary);">${currentWorld.tone.primary}${(currentWorld.tone.labels && currentWorld.tone.labels.length > 1) ? "（" + currentWorld.tone.labels.join(" / ") + "）" : ""}${currentWorld.tone.description ? " — " + currentWorld.tone.description : ""}</p>
        </div>` : ""}
        ${currentWorld.source_content ? `
        <div class="form-group">
            <label>源文件</label>
            <p style="margin:0;font-size:14px;color:var(--text-secondary);">已上传（${Math.ceil(currentWorld.source_content.length / 1024)} KB）</p>
        </div>` : ""}
    `;
    showModal("worldDetailModal");
}

async function startGame() {
    closeModal("worldDetailModal");
    if (!currentWorld) return;
    stopTypewriter();

    // G1 性能优化：进入世界时按需惰性重算 embedding（fire-and-forget，不阻塞开场）。
    // 仅对当前 world 重算，且 computeEmbeddingsForWorld 内部会跳过「内容未变」的片段。
    if (typeof computeEmbeddingsForWorld === "function") {
        computeEmbeddingsForWorld(currentWorld)
            .catch(function (e) { console.warn("embedding 重算失败(可忽略):", e && e.message); })
            .then(function () { if (typeof saveWorlds === "function") saveWorlds(); });
    }

    // ★ 主角设定：进入世界前在世界详情弹窗填写，这里读取并写入世界（玩家留空则保留旧值/交 AI 设计）
    const heroEditEl = document.getElementById("heroDescEdit");
    currentWorld.hero = heroEditEl ? (heroEditEl.value.trim() || currentWorld.hero) : currentWorld.hero;
    saveWorlds();

    // 加载该世界的初始状态
    if (currentWorld.initial_state) {
        gameState = deepClone(currentWorld.initial_state);
    } else {
        gameState = deepClone(defaultInitialState());
        gameState.name = currentWorld.hero ? "主角" : "玩家";
    }

    // ★ P0/P1: 重置缓存 + 聊天历史 + 摘要
    invalidateSystemPromptCache();
    conversationHistory = [];
    chatHistory = [];  // ★ 开场白已注入 system prompt，chatHistory 从空开始
    chatSummary = [];
    saveState();
    renderScenePanel();

    showScreen("gameScreen");
    // ★ 进入游戏后隐藏"编辑主角"按钮（主角设定只能在进入世界前编辑）
    var heroBtn = document.getElementById("heroEditBtn");
    if (heroBtn) heroBtn.style.display = "none";
    document.getElementById("gameWorldName").textContent = currentWorld.name;
    updateGameDayInfo();
    renderLog(true);
    renderChoices([]);

    // 开场白（UI 展示，不推入 chatHistory）
    const openingText = currentWorld.opening_narrative
        ? currentWorld.opening_narrative
        : `你进入了「${currentWorld.name}」。\n\n${currentWorld.desc}\n\n旅程即将开始，请做出你的第一个行动。`;
    conversationHistory.push({
        player: "",
        narrative: openingText,
        retrieved: [],
        period: gameState.current_date.period,
        day: gameState.current_date.day,
        key_facts: []
    });
    // ★ P1: 开场白已注入 system prompt（固定，命中缓存），不再作为首条 chatHistory 消息
    // 第一轮 API 请求结构：[system(含开场白), user1] — 与 DeepSeek 官方 Example 1 一致

    saveState();
    renderLog();
    await startTypewriter(conversationHistory.length - 1);

    // 打字完成后显示开场选项
    if (currentWorld.initial_choices && currentWorld.initial_choices.length) {
        currentChoices = currentWorld.initial_choices;
        renderChoices(currentChoices);
    }

    // ★ CRPG: 初始化动作菜单 + 地图
    if (typeof ActionMenu !== "undefined") {
        ActionMenu.render(gameState);
    }
    // ★ 渲染地图（如果初始状态包含地图数据）
    if (gameState.current_map && typeof TileMap !== "undefined") {
        if (currentWorld && currentWorld.fog_of_war !== false
            && !gameState.current_map.explored
            && typeof initFog === "function") {
            initFog(gameState.current_map);
        }
        TileMap.render(gameState.current_map);
    }
    if (typeof updateTopPanelPlaceholder === "function") {
        updateTopPanelPlaceholder();
    }
}

// ★ 编辑主角：游戏中随时可设定 / 修改主角身份与背景（满足「每次都能设定主角」）
function openHeroEdit() {
    if (!currentWorld) return;
    const el = document.getElementById("heroEditInput");
    if (el) el.value = currentWorld.hero || "";
    showModal("heroEditModal");
}
function saveHeroEdit() {
    if (!currentWorld) return;
    const el = document.getElementById("heroEditInput");
    currentWorld.hero = el ? (el.value.trim() || "") : currentWorld.hero;
    saveWorlds();
    invalidateSystemPromptCache(); // 主角设定影响 system prompt，强制刷新缓存
    // 立即把最新主角设定同步进存档对象，使「存档列表」立刻可见（满足需求：存档处能看到主角信息）
    if (typeof createOrUpdateSave === "function") createOrUpdateSave();
    closeModal("heroEditModal");
    showToast("主角设定已更新", "success");
}

// ★ 每个遇到的 NPC 都可设定人物卡（外貌/性格/描述/备注），存入 npc_states[name].card
let currentNpcCardName = "";
function editNpcCard(name) {
    if (!gameState) return;
    currentNpcCardName = name;
    const ns = (gameState.npc_states && gameState.npc_states[name]) || {};
    const card = ns.card || {};
    document.getElementById("npcCardTitle").textContent = "人物卡 · " + name;
    document.getElementById("npcCardAppearance").value = card.appearance || "";
    document.getElementById("npcCardTraits").value = card.traits || "";
    document.getElementById("npcCardDesc").value = card.desc || "";
    document.getElementById("npcCardNote").value = card.note || "";
    showModal("npcCardModal");
}
function saveNpcCard() {
    if (!gameState || !currentNpcCardName) return;
    if (!gameState.npc_states) gameState.npc_states = {};
    if (!gameState.npc_states[currentNpcCardName]) gameState.npc_states[currentNpcCardName] = {};
    const ns = gameState.npc_states[currentNpcCardName];
    ns.card = {
        appearance: document.getElementById("npcCardAppearance").value.trim(),
        traits: document.getElementById("npcCardTraits").value.trim(),
        desc: document.getElementById("npcCardDesc").value.trim(),
        note: document.getElementById("npcCardNote").value.trim()
    };
    closeModal("npcCardModal");
    saveState();
    saveWorlds();
    if (typeof currentStatusTab !== "undefined") renderStatusPanel(currentStatusTab);
    showToast("人物卡已保存", "success");
}

function defaultInitialState() {
    return {
        name: "玩家",
        age: 16,
        background: "一个误入了陌生世界的普通人。",
        personality: ["谨慎", "好奇"],
        attributes: {
            courage: "初来乍到，遇事不免有些畏缩，但还不到仓皇逃窜的地步。",
            perception: "对周遭动静还算留心，偶尔会注意到旁人忽略的细节。",
            patience: "能坐得住一时半刻，但若长久无望，也会焦躁起来。",
            luck: "不好不坏，像被世界随手一扔的普通石子。",
            will: "心志尚浅，却还没被现实完全磨平。"
        },
        progression: { path: "未入门", rank: "凡人", progress: 0 },
        relationships: {},
        skills: {},
        inventory: [],
        factions: {},
        active_quests: [],
        currency: { gold: 0 },
        crafting_recipes: [],
        equipped: {},
        completed_events: [],
        current_location: "初始地点",
        current_date: { day: 1, period: "morning" },
        goals: [],
        status_effects: [],
        is_alive: true,
        death_reason: null,
        combat_stats: {
            max_hp: 12, hp: 12,
            max_mp: 4,  mp: 4,
            ac: 12,
            level: 1, xp: 0, xp_to_next: 300,
            strength:     { value: 10, mod: 0, desc: "普通人的力气" },
            dexterity:    { value: 10, mod: 0, desc: "动作没有特别灵巧之处" },
            constitution: { value: 10, mod: 0, desc: "体质跟大多数人无异" },
            intelligence: { value: 10, mod: 0, desc: "智力平平" },
            wisdom:       { value: 10, mod: 0, desc: "直觉并不特别敏锐" },
            charisma:     { value: 10, mod: 0, desc: "举手投足间毫无特殊魅力" },
            in_combat: false
        }
    };
}

function loadSave(saveId) {
    const save = saves.find(s => s.id === saveId);
    if (!save) return;
    stopTypewriter();
    currentWorld = worlds.find(w => w.id === save.worldId);
    invalidateSystemPromptCache();
    if (save.state) gameState = deepClone(save.state);
    if (save.history) conversationHistory = deepClone(save.history);
    chatHistory = save.chatHistory ? deepClone(save.chatHistory) : rebuildChatFromHistory(save.history);
    chatSummary = (save.chatSummary && save.chatSummary.length) ? deepClone(save.chatSummary) : rebuildSummaryFromHistory(save.history);

    // ★ CRPG: 兼容旧存档，补齐 combat_stats（叙事模式不注入，保持纯叙事无数值）
    if (!isNarrativeMode() && !gameState.combat_stats) {
        gameState.combat_stats = {
            max_hp: 12, hp: 12, max_mp: 4, mp: 4, ac: 12,
            level: 1, xp: 0, xp_to_next: 300,
            strength:     { value: 10, mod: 0, desc: "普通人的力气" },
            dexterity:    { value: 10, mod: 0, desc: "动作没有特别灵巧之处" },
            constitution: { value: 10, mod: 0, desc: "体质跟大多数人无异" },
            intelligence: { value: 10, mod: 0, desc: "智力平平" },
            wisdom:       { value: 10, mod: 0, desc: "直觉并不特别敏锐" },
            charisma:     { value: 10, mod: 0, desc: "举手投足间毫无特殊魅力" },
            in_combat: false
        };
    }

    showToast(`加载存档：${save.worldName}`, "success");
    showScreen("gameScreen");
    // ★ 加载存档后隐藏"编辑主角"按钮
    var heroBtn = document.getElementById("heroEditBtn");
    if (heroBtn) heroBtn.style.display = "none";
    document.getElementById("gameWorldName").textContent = save.worldName;
    updateGameDayInfo();

    // 检查存档是否为死亡状态
    checkDeathBanner();

    renderLog(true);
    renderChoices([]);
    updateInputState();

    // ★ 从历史恢复最后一条有选项的记录
    restoreLastChoices();

    // ★ CRPG: 渲染地图和动作菜单
    if (gameState.current_map && typeof TileMap !== "undefined") {
        // 旧存档可能没有 explored 网格：若世界开启迷雾则补初始化（按玩家起点揭示）
        if (currentWorld && currentWorld.fog_of_war !== false
            && gameState.current_map.explored === undefined
            && typeof initFog === "function") {
            initFog(gameState.current_map);
        }
        TileMap.render(gameState.current_map);
    }
    if (typeof ActionMenu !== "undefined") {
        ActionMenu.render(gameState);
    }
    if (typeof renderCombatPanel === "function") {
        renderCombatPanel();
    }
    if (typeof updateTopPanelPlaceholder === "function") {
        updateTopPanelPlaceholder();
    }
}

function deleteSave(saveId) {
    if (!confirm("确定要删除这个存档吗？")) return;
    saves = saves.filter(s => s.id !== saveId);
    saveSaves();
    renderSaveList();
    showToast("存档已删除", "success");
}

function deleteWorld(worldId) {
    const world = worlds.find(w => w.id === worldId);
    if (!world) return;
    if (!confirm(`确定要删除世界「${world.name}」吗？\n该世界的所有记忆库、状态、存档将被一并删除，此操作不可撤销。`)) return;
    // 删除该世界的存档
    saves = saves.filter(s => s.worldId !== worldId);
    saveSaves();
    // 如果当前正在玩的就是这个世界，清除运行状态
    if (currentWorld && currentWorld.id === worldId) {
        currentWorld = null;
        gameState = null;
        conversationHistory = [];
        chatHistory = [];
        invalidateSystemPromptCache();
        localStorage.removeItem(STORAGE_KEYS.state);
        localStorage.removeItem(STORAGE_KEYS.history);
        localStorage.removeItem(STORAGE_KEYS.chatHistory);
    }
    // 从世界列表中移除
    worlds = worlds.filter(w => w.id !== worldId);
    saveWorlds();
    renderWorldList();
    showToast(`世界「${world.name}」已删除`, "success");
}

function createOrUpdateSave() {
    if (!currentWorld || !gameState) return;
    const existing = saves.find(s => s.worldId === currentWorld.id);
    const progress = `第 ${gameState.current_date.day} 天 · ${getPeriodLabel(gameState.current_date.period)}`;
    const now = new Date().toLocaleString("zh-CN", { hour12: false });
    const cleanHistory = conversationHistory.filter(e => !e.isWarning);
    const cleanChat = deepClone(chatHistory);
    // 预序列化，共享给 saveState，避免重复 JSON.stringify
    const stateStr = JSON.stringify(gameState);
    const historyStr = JSON.stringify(conversationHistory);
    const cleanHistoryStr = JSON.stringify(cleanHistory);
    if (existing) {
        existing.progress = progress; existing.updatedAt = now;
        existing.hero = currentWorld.hero || "";
        existing.state = JSON.parse(stateStr);
        existing.history = JSON.parse(cleanHistoryStr);
        existing.chatHistory = cleanChat;
        existing.chatSummary = chatSummary;
    } else {
        saves.unshift({
            id: "s" + Date.now(), worldId: currentWorld.id, worldName: currentWorld.name,
            progress, updatedAt: now, hero: currentWorld.hero || "",
            state: JSON.parse(stateStr), history: JSON.parse(cleanHistoryStr), chatHistory: cleanChat,
            chatSummary: [...chatSummary]
        });
    }
    saveSaves();
    // 使用已序列化的字符串保存 localStorage，避免 saveState 再次序列化
    saveState({ state: stateStr, history: historyStr, chatHistory: JSON.stringify(chatHistory) });
    // D1 修正：behavior_records 存放在 currentWorld（worlds 数组内），必须随每轮同步落盘，
    // 不能仅依赖 addBehaviorRecords 的 400ms 防抖——否则关标签瞬间会丢失关键事实。
    saveWorlds();
}

/* ================= 角色状态面板 ================= */
function showStatusPanel() {
    currentStatusTab = "profile";
    renderStatusTabs();
    renderStatusPanel(currentStatusTab);
    document.getElementById("statusPanelOverlay").classList.add("show");
}

function hideStatusPanel() {
    document.getElementById("statusPanelOverlay").classList.remove("show");
}

function closeStatusPanel(event) {
    if (event.target.id === "statusPanelOverlay") {
        hideStatusPanel();
    }
}

function renderStatusTabs() {
    const schema = getWorldSchema(currentWorld);
    const tabs = [
        { key: "profile", label: "角色" },
        { key: "relations", label: "关系" },
        { key: "items", label: "收集" },
        { key: "factions", label: "势力" },
        { key: "goals", label: "目标" },
        { key: "story", label: "剧情" },
        { key: "memory", label: "记忆" },
        { key: "world", label: "世界" }
    ];

    document.getElementById("statusTabs").innerHTML = tabs.map(t => `
        <button class="status-tab ${currentStatusTab === t.key ? "active" : ""}" onclick="switchStatusTab('${t.key}')">${t.label}</button>
    `).join("");
}

function switchStatusTab(tab) {
    currentStatusTab = tab;
    renderStatusTabs();
    renderStatusPanel(tab);
}

function getAttributeLabel(key) {
    const schema = getWorldSchema(currentWorld);
    return (schema.attribute_labels && schema.attribute_labels[key]) || key;
}

function renderTextAttribute(label, value) {
    const text = renderTextValue(value);
    return `
        <div class="row" style="align-items:flex-start;"><span class="label">${label}</span></div>
        <div class="text-block" style="margin-bottom:10px;">${text}</div>
    `;
}

function renderTextValue(value) {
    if (typeof value === "string") return escapeHtml(value);
    if (typeof value === "number") return `数值 ${value}（旧版兼容）`;
    if (value && typeof value === "object") {
        if (value.description) return escapeHtml(value.description);
        return escapeHtml(JSON.stringify(value));
    }
    return "暂无描述";
}

function renderStatusPanel(tab) {
    const container = document.getElementById("statusContent");
    if (!gameState) {
        container.innerHTML = '<div class="empty-hint">暂无角色数据</div>';
        return;
    }
    const s = gameState;
    const schema = getWorldSchema(currentWorld);

    switch (tab) {
        case "profile":
            container.innerHTML = `
                <div class="status-section">
                    <div class="status-section-title">基本信息</div>
                    <div class="status-card">
                        <div class="row"><span class="label">姓名</span><span class="value">${s.name}</span></div>
                        <div class="row"><span class="label">年龄</span><span class="value">${s.age}</span></div>
                        <div class="row"><span class="label">当前地点</span><span class="value">${s.current_location}</span></div>
                        <div class="row"><span class="label">时间</span><span class="value">第 ${s.current_date.day} 天 · ${getPeriodLabel(s.current_date.period)}</span></div>
                    </div>
                </div>
                <div class="status-section">
                    <div class="status-section-title">出身与性格</div>
                    <div class="status-card text-block">${s.background || "（未设定）"}</div>
                    <div class="status-tag-list" style="margin-top:8px;">${(s.personality || []).map(p => `<span class="status-tag">${p}</span>`).join("") || '<span class="empty-hint" style="padding:0">未设置</span>'}</div>
                    ${s.completed_events.length ? `<div class="status-tag-list" style="margin-top:8px;"><span style="font-size:11px;color:var(--text-muted);margin-right:4px;">已完成</span>${s.completed_events.map(e => `<span class="status-tag">${e}</span>`).join("")}</div>` : ""}
                </div>
                <details class="status-details">
                    <summary>属性详情</summary>
                    <div class="status-card" style="margin-top:8px;">
                        ${Object.entries(s.attributes).map(([k, v]) => renderTextAttribute(getAttributeLabel(k), v)).join("")}
                    </div>
                </details>
                <div class="status-section">
                    <div class="status-section-title">${schema.progression_label || "进度"}</div>
                    <div class="status-card">
                        <div class="row"><span class="label">${schema.progression_path_label || "路线"}</span><span class="value">${s.progression.path}</span></div>
                        <div class="row"><span class="label">${schema.progression_label || "等级"}</span><span class="value">${s.progression.rank}</span></div>
                        <div class="row"><span class="label">进度</span><span class="value">${s.progression.progress}</span></div>
                        <div class="stat-bar"><div style="width:${Math.min(s.progression.progress, 100)}%"></div></div>
                    </div>
                </div>
                ${s.combat_stats ? `
                <details class="status-details">
                    <summary>战斗数值</summary>
                    <div class="status-card" style="margin-top:8px;">
                        <div class="row"><span class="label">等级</span><span class="value">Lv.${s.combat_stats.level} (${s.combat_stats.xp}/${s.combat_stats.xp_to_next} XP)</span></div>
                        <div class="stat-bar xp-bar"><div style="width:${s.combat_stats.xp_to_next > 0 ? s.combat_stats.xp / s.combat_stats.xp_to_next * 100 : 0}%; background: var(--primary);"></div></div>
                        <div class="row"><span class="label">生命值 HP</span><span class="value" style="color: var(--danger);">${s.combat_stats.hp} / ${s.combat_stats.max_hp}</span></div>
                        <div class="stat-bar hp-bar"><div style="width:${s.combat_stats.max_hp > 0 ? s.combat_stats.hp / s.combat_stats.max_hp * 100 : 0}%; background: var(--danger);"></div></div>
                        <div class="row"><span class="label">法力值 MP</span><span class="value" style="color: #6BA4D4;">${s.combat_stats.mp} / ${s.combat_stats.max_mp}</span></div>
                        <div class="stat-bar mp-bar"><div style="width:${s.combat_stats.max_mp > 0 ? s.combat_stats.mp / s.combat_stats.max_mp * 100 : 0}%; background: #6BA4D4;"></div></div>
                        <div class="row"><span class="label">护甲 AC</span><span class="value">${s.combat_stats.ac}</span></div>
                        ${s.combat_stats.in_combat ? '<div class="row"><span class="label" style="color: var(--danger);">状态</span><span class="value" style="color: var(--danger);">战斗中</span></div>' : ''}
                        ${['strength','dexterity','constitution','intelligence','wisdom','charisma'].map(k => {
                            const attr = s.combat_stats[k];
                            const labels = { strength: '力量 STR', dexterity: '敏捷 DEX', constitution: '体质 CON', intelligence: '智力 INT', wisdom: '感知 WIS', charisma: '魅力 CHA' };
                            if (!attr) return '';
                            const mod = attr.mod >= 0 ? '+' + attr.mod : attr.mod;
                            return '<div class="row"><span class="label">' + labels[k] + '</span><span class="value">' + attr.value + ' (' + mod + ')</span></div>';
                        }).join('')}
                        ${(s.equipped && (s.equipped.weapon || s.equipped.armor || s.equipped.accessory)) ? '<div class="status-section-title" style="margin-top:10px;font-size:12px;">已装备</div>' + ['weapon','armor','accessory'].filter(function(slot){ return s.equipped[slot]; }).map(function(slot){
                            const it = s.inventory.find(function(i){ return i.item_id === s.equipped[slot]; });
                            if (!it) return '';
                            const bonus = (slot==='weapon' && it.damage_bonus ? ' 伤害+'+it.damage_bonus : '') + (slot==='armor' && it.ac_bonus ? ' 防御+'+it.ac_bonus : '');
                            const slotName = { weapon:'武器', armor:'护甲', accessory:'饰品' }[slot];
                            return '<div class="row"><span class="label">'+slotName+'</span><span class="value">'+it.name+(bonus?bonus:'')+'</span></div>';
                        }).join('') : ''}
                    </div>
                </details>` : ''}
                <div class="status-section">
                    <div class="status-section-title">声望与张力</div>
                    <div class="status-card">
                        <div class="row"><span class="label">声望</span><span class="value">${reputationTitle(s.reputation || 0)} (${s.reputation || 0})</span></div>
                        <div class="stat-bar"><div style="width:${Math.min(s.reputation || 0, 100)}%;background:var(--primary)"></div></div>
                        <div class="row"><span class="label">张力</span><span class="value">${tensionTitle(s.tension || 0)} (${s.tension || 0})</span></div>
                        <div class="stat-bar"><div style="width:${Math.min(s.tension || 0, 100)}%;background:var(--danger)"></div></div>
                    </div>
                </div>
                <div class="status-section">
                    <div class="status-section-title">临时状态</div>
                    <div class="status-card">
                        ${(s.status_effects && s.status_effects.length) ? s.status_effects.map(e => `<div class="row"><span class="label">${e.name}</span><span class="value">${e.desc}</span></div>`).join("") : '<div class="empty-hint">无临时状态</div>'}
                    </div>
                </div>
            `;
            break;

        case "relations":
            {
                const relEntries = Object.entries(s.relationships);
                const npcEntries = Object.entries(s.npc_states || {});
                container.innerHTML = `
                    ${relEntries.length ? `
                    <div class="status-section">
                        <div class="status-section-title">人物关系</div>
                        ${relEntries.map(([name, value]) => `
                            <div class="status-card">
                                <div class="row"><span class="label">${name}</span></div>
                                <div class="text-block">${renderTextValue(value)}</div>
                            </div>
                        `).join("")}
                    </div>` : ''}
                    <div class="status-section">
                        <div class="status-section-title">NPC 档案</div>
                        ${npcEntries.length ? npcEntries.map(([name, ns]) => {
                            const a = typeof ns.attitude === "number" ? ns.attitude : null;
                            const pct = a !== null ? Math.max(0, Math.min(100, (a + 100) / 2)) : 50;
                            const barColor = a !== null && a < 0 ? "var(--danger)" : "var(--primary)";
                            const card = ns.card || {};
                            const hasCard = card.desc || card.traits || card.appearance || card.note;
                            return `<div class="status-card">
                                <div class="row"><span class="label">${name}</span><span class="value">${a !== null ? tierLabel(attitudeTier(a)) + " (" + a + ")" : "—"}</span></div>
                                ${a !== null ? `<div class="stat-bar"><div style="width:${pct}%;background:${barColor}"></div></div>` : ""}
                                ${card.desc ? `<div class="text-block">${card.desc}</div>` : ""}
                                ${card.traits ? `<div class="status-tag-list" style="margin-top:6px;"><span style="font-size:11px;color:var(--text-muted);margin-right:4px;">性格</span>${card.traits.split(/[,，]/).map(t=>`<span class="status-tag">${t.trim()}</span>`).join("")}</div>` : ""}
                                ${card.appearance ? `<div class="text-block" style="font-size:12px;color:var(--text-muted)">外貌：${card.appearance}</div>` : ""}
                                ${ns.mood ? `<div class="row"><span class="label">心情</span><span class="value">${ns.mood}</span></div>` : ""}
                                ${ns.catchphrase ? `<div class="row"><span class="label">口头禅</span><span class="value">${ns.catchphrase}</span></div>` : ""}
                                ${ns.secrets && ns.secrets.length ? `<div class="text-block" style="font-size:12px;color:var(--text-muted)">隐秘：${ns.secrets.join("；")}</div>` : ""}
                                ${card.note ? `<div class="text-block" style="font-size:12px;color:var(--text-muted)">备注：${card.note}</div>` : ""}
                                <button class="btn ghost tiny" style="margin-top:8px;" onclick="editNpcCard('${name.replace(/'/g, "\\'")}')">${hasCard ? "编辑人物卡" : "＋ 设定人物卡"}</button>
                            </div>`;
                        }).join("") : '<div class="empty-hint">暂无 NPC 档案</div>'}
                    </div>`;
            }
            break;

        case "items":
            {
                const skillEntries = Object.entries(s.skills || {});
                const cur = s.currency || {};
                const curEntries = Object.entries(cur).filter(e => e[1] > 0 || e[0] === "gold");
                const equippedIds = s.equipped || {};
                const TYPE_LABELS = { weapon: "武器", armor: "护甲", accessory: "饰品", consumable: "消耗", material: "材料", quest: "任务", other: "杂物" };
                container.innerHTML = `
                    <div class="status-section">
                        <div class="status-section-title">货币</div>
                        <div class="status-card">
                            ${curEntries.length ? curEntries.map(e => '<div class="row"><span class="label">' + currencyLabel(e[0]) + '</span><span class="value">×' + e[1] + '</span></div>').join("") : '<div class="empty-hint">身无分文</div>'}
                        </div>
                    </div>
                    <div class="status-section">
                        <div class="status-section-title">背包物品</div>
                        ${s.inventory.length ? s.inventory.map(function(i) {
                            const isEq = equippedIds[i.slot] === i.item_id;
                            const typeTag = i.type ? '<span class="status-tag" style="margin-left:6px;">' + (TYPE_LABELS[i.type] || i.type) + '</span>' : '';
                            const eqBtn = i.equippable ? '<button class="btn ghost tiny" style="margin-top:6px;" onclick="toggleEquip(\'' + i.item_id.replace(/'/g, "\\'") + '\')">' + (isEq ? "卸下" : "装备") + '</button>' : '';
                            const bonus = (i.damage_bonus ? " 伤害+" + i.damage_bonus : "") + (i.ac_bonus ? " 防御+" + i.ac_bonus : "");
                            return '<div class="status-card"><div class="row"><span class="label">' + i.name + (isEq ? ' <span style="color:var(--primary);font-size:11px;">[已装备]</span>' : '') + '</span><span class="value">×' + i.count + '</span></div>' + typeTag + (bonus ? '<div class="text-block" style="font-size:11px;color:var(--text-muted)">' + bonus.trim() + '</div>' : '') + (i.desc ? '<div class="text-block" style="font-size:11px;color:var(--text-muted)">' + i.desc + '</div>' : '') + eqBtn + '</div>';
                        }).join("") : '<div class="empty-hint">背包空空如也</div>'}
                    </div>
                    <div class="status-section">
                        <div class="status-section-title">⚒ 合成工坊（已知配方）</div>
                        ${(s.crafting_recipes && s.crafting_recipes.length) ? s.crafting_recipes.map(function(r) {
                            const inv = s.inventory || [];
                            const ok = (r.inputs || []).every(function(req) { const h = inv.find(i => i.item_id === req.item_id); return h && h.count >= req.count; });
                            const reqText = (r.inputs || []).map(function(req) { const h = inv.find(i => i.item_id === req.item_id); const have = h ? h.count : 0; return (req.name || req.item_id) + " " + have + "/" + req.count; }).join("，");
                            const outText = r.output ? (r.output.name + " ×" + (r.output.count || 1)) : "—";
                            return '<div class="status-card"><div class="row"><span class="label">' + r.name + '</span></div>' + (r.desc ? '<div class="text-block" style="font-size:11px;color:var(--text-muted)">' + r.desc + '</div>' : '') + '<div class="text-block" style="font-size:11px;">材料：' + (reqText || "无") + '<br>产出：' + outText + '</div><button class="btn ghost tiny" style="margin-top:6px;" ' + (ok ? 'onclick="doCraft(\'' + r.id.replace(/'/g, "\\'") + '\')"' : 'disabled style="opacity:.5;cursor:not-allowed;"') + '>' + (ok ? "合成" : "材料不足") + '</button></div>';
                        }).join("") : '<div class="empty-hint">尚未习得任何配方（在剧情中探索制作法吧）</div>'}
                    </div>
                    <div class="status-section">
                        <div class="status-section-title">🏪 商店（固定货架 / 定价）</div>
                        ${(currentWorld && currentWorld.shops && currentWorld.shops.length) ? currentWorld.shops.map(function(sh) {
                            const cur = sh.currency || 'gold';
                            return '<div class="status-card"><div class="row"><span class="label">'+escapeHtml(sh.name)+'</span><span class="value">'+(sh.owner?escapeHtml(sh.owner):'—')+'</span></div>'+(sh.location?'<div class="text-block" style="font-size:11px;color:var(--text-muted)">位置：'+escapeHtml(sh.location)+' · 货币：'+currencyLabel(cur)+'</div>':'<div class="text-block" style="font-size:11px;color:var(--text-muted)">货币：'+currencyLabel(cur)+'</div>')+'<button class="btn ghost tiny" style="margin-top:6px;" onclick="openShopModal(\''+sh.id.replace(/'/g,"\\'")+'\')">浏览货架 / 交易</button></div>';
                        }).join("") : '<div class="empty-hint">这个世界还没有开设店铺</div>'}
                    </div>
                    ${skillEntries.length ? `
                    <div class="status-section">
                        <div class="status-section-title">已掌握${schema.skill_label || "技能"}</div>
                        ${skillEntries.map(([name, value]) => `
                            <div class="status-card">
                                <div class="row"><span class="label">${name}</span></div>
                                <div class="text-block">${renderTextValue(value)}</div>
                            </div>
                        `).join("")}
                    </div>` : ''}
                `;
            }
            break;

        case "factions":
            {
                const facs = s.factions || {};
                const facEntries = Object.entries(facs);
                container.innerHTML = `
                    <div class="status-section">
                        <div class="status-section-title">阵营声望</div>
                        ${facEntries.length ? facEntries.map(function(e) {
                            const name = e[0], f = e[1] || {};
                            const rep = f.reputation || 0;
                            const pct = Math.max(0, Math.min(100, (rep + 100) / 2));
                            const stance = f.stance || "中立";
                            const isFriend = (stance === "友善" || stance === "崇敬");
                            const isHostile = (stance === "冷淡" || stance === "敌视");
                            const color = isFriend ? "#3a9d5d" : isHostile ? "var(--danger)" : "var(--text-muted)";
                            return '<div class="status-card"><div class="row"><span class="label">' + name + '</span><span class="value" style="color:' + color + '">' + stance + ' (' + rep + ')</span></div><div class="stat-bar"><div style="width:' + pct + '%;background:' + color + '"></div></div>' + (f.desc ? '<div class="text-block" style="font-size:11px;color:var(--text-muted)">' + f.desc + '</div>' : '') + '</div>';
                        }).join("") : '<div class="empty-hint">尚未与任何势力产生交集</div>'}
                    </div>
                    <div class="status-section">
                        <div class="status-section-title">📜 任务板（可接取）</div>
                        ${(currentWorld && currentWorld.quest_board && currentWorld.quest_board.filter(function(q){return q.status==='open';}).length) ? currentWorld.quest_board.filter(function(q){return q.status==='open';}).map(function(q){
                            const fac = q.faction ? ' <span class="status-tag">'+escapeHtml(q.faction)+'</span>' : '';
                            const rew = [];
                            if (q.reward && q.reward.currency) for (const c in q.reward.currency) rew.push(currencyLabel(c)+' +'+q.reward.currency[c]);
                            if (q.reward && q.reward.reputation) for (const f in q.reward.reputation) rew.push(f+' 声望 +'+q.reward.reputation[f]);
                            return '<div class="status-card"><div class="row"><span class="label">'+escapeHtml(q.title)+'</span></div>'+fac+(q.desc?'<div class="text-block" style="font-size:11px;color:var(--text-muted)">'+escapeHtml(q.desc)+'</div>':'')+(rew.length?'<div class="text-block" style="font-size:11px;">奖励：'+rew.join('，')+'</div>':'')+'<button class="btn ghost tiny" style="margin-top:6px;" onclick="acceptQuestFromBoard(\''+q.id.replace(/'/g,"\\'")+'\')">接受任务</button></div>';
                        }).join("") : '<div class="empty-hint">暂无可接取的任务</div>'}
                    </div>
                    <div class="status-section">
                        <div class="status-section-title">🎯 进行中任务</div>
                        ${(s.active_quests && s.active_quests.length) ? s.active_quests.map(function(q){
                            const isDone = q.status==='completed';
                            const chk = (typeof checkQuestDeliver==='function') ? checkQuestDeliver(s, q) : {ok:true};
                            return '<div class="status-card"><div class="row"><span class="label">'+escapeHtml(q.title)+(isDone?' <span style="color:var(--primary);font-size:11px;">[已完成]</span>':'')+'</span></div>'+(q.faction?'<div class="text-block" style="font-size:11px;color:var(--text-muted)">势力：'+escapeHtml(q.faction)+'</div>':'')+(q.desc?'<div class="text-block" style="font-size:11px;color:var(--text-muted)">'+escapeHtml(q.desc)+'</div>':'')+(!isDone?'<button class="btn ghost tiny" style="margin-top:6px;" '+(chk.ok?'onclick="turnInActiveQuest(\''+q.id.replace(/'/g,"\\'")+'\')"':'disabled style="opacity:.5;cursor:not-allowed;"')+'>'+(chk.ok?'交付 / 完成':'交付物不足')+'</button>':'')+'</div>';
                        }).join("") : '<div class="empty-hint">尚无进行中的任务（去任务板接取吧）</div>'}
                    </div>`;
            }
            break;

        case "goals":
            container.innerHTML = `
                <div class="status-section">
                    <div class="status-section-title">当前目标</div>
                    ${s.goals.length ? s.goals.map(g => {
                        let cls = "";
                        if (g.status === "completed") cls = "completed";
                        else if (g.status === "failed") cls = "failed";
                        const deadline = g.deadline ? `截止：第${g.deadline.day}天 ${getPeriodLabel(g.deadline.period)}` : "无期限";
                        const prog = typeof g.progress === "number" ? g.progress : 0;
                        const tier = g.tier ? ` · ${g.tier === "main" ? "主线" : g.tier === "side" ? "支线" : "个人"}` : "";
                        return `<div class="goal-item ${cls}"><strong>${g.name}</strong><br><span style="font-size:11px;color:var(--text-muted)">${g.type}${tier} · ${deadline}</span>${prog > 0 ? `<div class="stat-bar" style="margin-top:4px;"><div style="width:${Math.min(prog,100)}%"></div></div>` : ""}</div>`;
                    }).join("") : '<div class="empty-hint">暂无目标</div>'}
                </div>
            `;
            break;

        case "world":
            {
                const evs = (currentWorld && currentWorld.current_world_events) || [];
                const leg = (currentWorld && currentWorld.inherited_legend) || null;
                const legendBlock = leg ? `
                    <div class="status-section">
                        <div class="status-section-title">📜 继承的传说（前世余音）</div>
                        <div class="status-card">
                            <div class="row"><span class="label">前世旅人</span><span class="value">${leg.heroName || "无名旅人"}</span></div>
                            <div class="row"><span class="label">来自世界</span><span class="value">${leg.worldName || "未知"}</span></div>
                            <div class="text-block">${leg.summary || "（暂无记载）"}</div>
                        </div>
                    </div>` : "";
                const log = s.choice_log || [];
                container.innerHTML = `
                    <button class="btn ghost tiny" style="margin-bottom:10px;" onclick="openWorldBookModal()">📖 编辑世界书</button>
                    <button class="btn ghost tiny" style="margin-bottom:10px;margin-left:6px;" onclick="openSnapshotModal()">🕰️ 分支快照 / 多时间线</button>
                    ${legendBlock}
                    <div class="status-section">
                        <div class="status-section-title">世界近期动态（世界脉搏）</div>
                        ${evs.length ? evs.slice().reverse().map(e => `<div class="status-card"><div class="row"><span class="label">[${e.type || "动态"}] 第${e.day}天</span></div><div class="text-block">${e.text}</div></div>`).join("") : '<div class="empty-hint">世界暂时风平浪静</div>'}
                    </div>
                    <div class="status-section">
                        <div class="status-section-title">抉择日志（你做出的每个选择）</div>
                        ${log.length ? log.slice().reverse().map(c => `<div class="status-card"><div class="row"><span class="label">第${c.day}天</span></div><div class="text-block">${c.text}</div>${c.consequence ? `<div class="text-block" style="font-size:12px;color:var(--text-muted)">倾向：${c.consequence}</div>` : ""}</div>`).join("") : '<div class="empty-hint">你还没有做出选择</div>'}
                    </div>`;
            }
            break;

        case "story":
            {
                const ca = (gameState && gameState.current_act) || (typeof computeCurrentAct === "function" ? computeCurrentAct() : { act: 1, title: "第一幕 · 启程", reason: "冒险刚刚开始" });
                const acts = (gameState && gameState.acts_log ? gameState.acts_log.slice() : []).sort((a, b) => a.act - b.act);
                const done = (gameState && gameState.completed_events) || [];
                container.innerHTML = `
                    <button class="btn ghost tiny" style="margin-bottom:12px;" onclick="openExportModal()">📤 导出故事（Markdown）</button>
                    <div class="status-section">
                        <div class="status-section-title">当前剧情阶段</div>
                        <div class="status-card" style="border-left:3px solid var(--primary);">
                            <div class="row"><span class="label" style="font-weight:600;">${escapeHtml(ca.title)}</span><span class="value">第 ${ca.act} 幕</span></div>
                            <div class="text-block" style="font-size:12px;color:var(--text-muted)">${escapeHtml(ca.reason)}</div>
                        </div>
                    </div>
                    ${acts.length ? `
                    <div class="status-section">
                        <div class="status-section-title">章节时间线</div>
                        ${acts.map(a => `
                            <div class="status-card">
                                <div class="row"><span class="label">${escapeHtml(a.title)}</span><span class="value">第${a.act}幕</span></div>
                                <div class="text-block" style="font-size:12px;color:var(--text-muted)">第${a.day}天 ${getPeriodLabel(a.period)} · ${escapeHtml(a.reason)}</div>
                            </div>`).join("")}
                    </div>` : ''}
                    <div class="status-section">
                        <div class="status-section-title">已完成大事记</div>
                        ${done.length ? done.map(e => `<div class="status-card"><div class="text-block">${escapeHtml(e)}</div></div>`).join("") : '<div class="empty-hint">尚无已完成的重大事件</div>'}
                    </div>
                `;
            }
            break;

        case "memory":
            {
                const all = getAllPinnedFacts();
                const active = all.filter(p => p.status === "active");
                const resolved = all.filter(p => p.status === "resolved");
                container.innerHTML = `
                    <div class="status-section">
                        <div class="status-section-title">恒定事实（不可违背的记忆）</div>
                        ${active.length ? active.map(p => `
                            <div class="status-card">
                                <div class="text-block">${escapeHtml(p.text)}</div>
                                <div class="row" style="margin-top:6px;font-size:11px;color:var(--text-muted);">
                                    <span>来源：${p.source === "ai" ? "AI 自动标注" : p.source === "state" ? "状态信号" : "手动"}</span>
                                    <button class="btn ghost tiny" style="margin-left:auto;" onclick="unpinMemoryFact('${p.id}')">解除</button>
                                </div>
                            </div>
                        `).join("") : '<div class="empty-hint">暂无恒定事实。重要誓言、诅咒、生死等会被自动钉住。</div>'}
                    </div>
                    <div class="status-section">
                        <div class="status-section-title">手动添加恒定事实</div>
                        <div class="status-card">
                            <input type="text" id="manualPinInput" class="text-input" placeholder="例如：玩家与风部结盟，互为奥援" style="width:100%;box-sizing:border-box;" />
                            <button class="btn ghost tiny" style="margin-top:8px;" onclick="addManualMemory()">＋ 钉住</button>
                        </div>
                    </div>
                    ${resolved.length ? `
                    <div class="status-section">
                        <div class="status-section-title">已解除（历史）</div>
                        ${resolved.map(p => `<div class="status-card"><div class="text-block" style="color:var(--text-muted);text-decoration:line-through;">${escapeHtml(p.text)}</div></div>`).join("")}
                    </div>` : ''}
                `;
            }
            break;
    }
}

function unpinMemoryFact(id) {
    if (typeof unpinFact === "function") unpinFact(id);
    if (typeof renderStatusPanel === "function") renderStatusPanel("memory");
}

// ★ ⑤ 货币展示名映射
function currencyLabel(cur) {
    const map = { gold: "金币", silver: "银币", coin: "铜钱", spirit_stone: "灵石", crystal: "魔晶" };
    return map[cur] || cur;
}

/* ================= C) 商店 NPC + 阵营任务 · UI 处理函数 ================= */

let _shopModalId = null;

// 打开店铺弹窗：列出货架 + 玩家背包可出售项
function openShopModal(shopId) {
    if (!currentWorld || !gameState) return;
    const shop = getShop(currentWorld, shopId);
    if (!shop) { showToast("店铺不存在", "error"); return; }
    _shopModalId = shopId;
    const cur = shop.currency || "gold";
    const curHave = (gameState.currency && typeof gameState.currency[cur] === "number") ? gameState.currency[cur] : 0;
    const modal = document.getElementById("shopModal");
    if (!modal) return;
    const stockHtml = (shop.stock && shop.stock.length) ? shop.stock.map(function(it) {
        const price = shopItemPrice(shop, it.item_id, gameState);
        const afford = curHave >= price;
        return '<div class="status-card"><div class="row"><span class="label">' + escapeHtml(it.name) + '</span><span class="value">×' + it.count + '</span></div>' +
            '<div class="text-block" style="font-size:11px;color:var(--text-muted)">' + (it.desc || "") + '</div>' +
            '<div class="row" style="margin-top:4px;"><span class="label" style="color:var(--gold,#caa24a)">' + price + ' ' + currencyLabel(cur) + '</span>' +
            '<button class="btn ghost tiny" ' + (afford && it.count > 0 ? 'onclick="buyShopItem(\'' + it.item_id.replace(/'/g, "\\'") + '\')"' : 'disabled style="opacity:.5;cursor:not-allowed;"') + '>' + (it.count > 0 ? "购买" : "售罄") + '</button></div></div>';
    }).join("") : '<div class="empty-hint">货架空空如也</div>';

    const sellable = (gameState.inventory || []).filter(function(i) { return shop.stock.some(function(s) { return s.item_id === i.item_id; }); });
    const sellHtml = sellable.length ? sellable.map(function(i) {
        const it = shop.stock.find(function(s) { return s.item_id === i.item_id; });
        const unit = Math.floor((it.price || 0) * 0.5);
        return '<div class="status-card"><div class="row"><span class="label">' + escapeHtml(i.name) + '</span><span class="value">×' + i.count + '</span></div>' +
            '<div class="row" style="margin-top:4px;"><span class="label" style="color:var(--gold,#caa24a)">回购 ' + unit + ' ' + currencyLabel(cur) + '</span>' +
            '<button class="btn ghost tiny" onclick="sellShopItem(\'' + i.item_id.replace(/'/g, "\\'") + '\')">出售</button></div></div>';
    }).join("") : '<div class="empty-hint">背包里没有该店收购的东西</div>';

    modal.querySelector("#shopModalName").textContent = shop.name + (shop.owner ? "（" + shop.owner + "）" : "");
    modal.querySelector("#shopModalCur").textContent = "持有：" + curHave + " " + currencyLabel(cur);
    modal.querySelector("#shopModalStock").innerHTML = stockHtml;
    modal.querySelector("#shopModalSell").innerHTML = sellHtml;
    modal.classList.add("show");
}

function closeShopModal() {
    const modal = document.getElementById("shopModal");
    if (modal) modal.classList.remove("show");
    _shopModalId = null;
}

function buyShopItem(itemId) {
    if (!_shopModalId || !currentWorld || !gameState) return;
    var r = buyFromShop(gameState, currentWorld, _shopModalId, itemId, 1);
    showToast(r.msg, r.ok ? "success" : "error");
    if (r.ok) {
        saveState();
        openShopModal(_shopModalId);
        if (typeof renderStatusPanel === "function") renderStatusPanel("items");
    }
}

function sellShopItem(itemId) {
    if (!_shopModalId || !currentWorld || !gameState) return;
    var r = sellToShop(gameState, currentWorld, _shopModalId, itemId, 1);
    showToast(r.msg, r.ok ? "success" : "error");
    if (r.ok) {
        saveState();
        // 刷新店铺弹窗 + 强制刷新物品面板
        openShopModal(_shopModalId);
        if (typeof renderStatusPanel === "function") renderStatusPanel("items");
    }
}

// 从任务板接受任务
function acceptQuestFromBoard(questId) {
    if (!currentWorld || !gameState) return;
    const r = acceptQuest(gameState, currentWorld, questId);
    showToast(r.msg, r.ok ? "success" : "error");
    if (r.ok) { if (typeof renderStatusPanel === "function") renderStatusPanel("factions"); if (typeof saveWorlds === "function") saveWorlds(); saveState(); }
}

// 交付 / 完成进行中任务
function turnInActiveQuest(questId) {
    if (!currentWorld || !gameState) return;
    const r = turnInQuest(gameState, currentWorld, questId);
    showToast(r.msg, r.ok ? "success" : "error");
    if (r.ok) { if (typeof renderStatusPanel === "function") renderStatusPanel("factions"); if (typeof saveWorlds === "function") saveWorlds(); saveState(); }
}

// ★ ⑤ 装备 / 卸下切换（全局供面板 onclick 调用）
function toggleEquip(itemId) {
    if (!gameState) return;
    const item = (gameState.inventory || []).find(function(i) { return i.item_id === itemId; });
    if (!item || !item.equippable || !item.slot) return;
    const equippedId = gameState.equipped && gameState.equipped[item.slot];
    if (equippedId === itemId) unequipItem(gameState, item.slot);
    else equipItem(gameState, itemId);
    saveState();
    if (typeof renderStatusPanel === "function") renderStatusPanel(currentStatusTab);
    if (typeof ActionMenu !== "undefined") ActionMenu.render(gameState);
}

// ★ ⑤ 合成：直接操作 inventory（绕过 applyStateChanges，避免 item_id 匹配不确定性）
function doCraft(recipeId) {
    if (!gameState) return;
    var recipe = (gameState.crafting_recipes || []).find(function(r) { return r.id === recipeId; });
    if (!recipe || !recipe.output) { showToast("配方无效", "warn"); return; }
    if (!gameState.inventory) gameState.inventory = [];
    var inv = gameState.inventory;
    // 校验材料
    var inputsOk = true;
    (recipe.inputs || []).forEach(function(req) {
        var have = inv.find(function(i) { return i.item_id === req.item_id; });
        if (!have || have.count < req.count) {
            showToast("材料不足：" + (req.name || req.item_id) + " 需 " + req.count, "warn");
            inputsOk = false;
        }
    });
    if (!inputsOk) return;
    // 消耗材料（直接修改，确保每次操作后 search 仍能匹配到最新 inventory）
    (recipe.inputs || []).forEach(function(req) {
        var item = gameState.inventory.find(function(i) { return i.item_id === req.item_id; });
        if (item) {
            item.count -= req.count;
            if (item.count <= 0) {
                gameState.inventory = gameState.inventory.filter(function(i) { return i.item_id !== req.item_id; });
            }
        }
    });
    // 产出成品
    var existing = gameState.inventory.find(function(i) { return i.item_id === recipe.output.item_id; });
    if (existing) {
        existing.count += (recipe.output.count || 1);
    } else {
        gameState.inventory.push({
            item_id: recipe.output.item_id, name: recipe.output.name,
            count: recipe.output.count || 1, type: recipe.output.type || null,
            equippable: recipe.output.equippable || false, slot: recipe.output.slot || null,
            damage_bonus: recipe.output.damage_bonus || 0, ac_bonus: recipe.output.ac_bonus || 0,
            desc: recipe.output.desc || ""
        });
    }
    saveState();
    showToast("合成成功：" + (recipe.output.name || recipe.output.item_id), "success");
    // 强制刷新物品面板（不管当前在哪个 tab）
    if (typeof renderStatusPanel === "function") renderStatusPanel("items");
    if (typeof ActionMenu !== "undefined") ActionMenu.render(gameState);
}

function addManualMemory() {
    const el = document.getElementById("manualPinInput");
    if (!el) return;
    const text = el.value.trim();
    if (!text) return;
    if (typeof addPinnedFacts === "function") addPinnedFacts([text], "manual");
    el.value = "";
    if (typeof renderStatusPanel === "function") renderStatusPanel("memory");
}

function updateGameDayInfo() {
    if (!gameState) return;
    const tc = getTimeConfig();
    if (tc.mode === "hidden") {
        document.getElementById("gameDayInfo").textContent = gameState.current_location || "";
        return;
    }
    if (tc.mode === "continuous") {
        document.getElementById("gameDayInfo").textContent = gameState.current_date.period || "";
        return;
    }
    document.getElementById("gameDayInfo").textContent = `第 ${gameState.current_date.day} 天 · ${getPeriodLabel(gameState.current_date.period)}`;
}

/* ================= UI 渲染 ================= */
function highlightItems(text) {
    if (!gameState || !gameState.inventory.length) return text;
    const names = gameState.inventory.map(i => i.name).filter(n => n);
    if (!names.length) return text;
    // 按名称长度降序，避免短名先替换导致长名无法匹配
    names.sort((a, b) => b.length - a.length);
    let html = escapeHtml(text);
    for (const name of names) {
        const regex = new RegExp(escapeHtml(name), "g");
        html = html.replace(regex, `<span class="item-highlight">${escapeHtml(name)}</span>`);
    }
    return html;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

let renderedEntryCount = 0;  // 增量渲染计数器，避免每轮重建整个日志 DOM

function renderLog(reset) {
    const log = document.getElementById("gameLog");
    if (reset) { renderedEntryCount = 0; log.innerHTML = '<div class="choices-row in-log" id="choicesArea"></div>'; }

    // 只追加新增的条目
    for (let i = renderedEntryCount; i < conversationHistory.length; i++) {
        const entry = conversationHistory[i];
        const warningClass = entry.isWarning ? " warning" : "";
        const metaLabel = entry.isWarning
            ? "系统提示"
            : (entry.player ? "你" : "开场");
        const html = `
        <div class="log-entry${warningClass}">
            <div class="meta">
                <span>${metaLabel} · 第${entry.day}天 ${getPeriodLabel(entry.period)}</span>
            </div>
            ${entry.player ? `<div class="player-text">${escapeHtml(entry.player)}</div>` : ""}
            <div class="narrative">${entry.isWarning ? escapeHtml(entry.narrative) : highlightItems(entry.narrative)}</div>
        </div>
        `;
        log.insertBefore(createElementFromHTML(html), document.getElementById("choicesArea"));
    }
    renderedEntryCount = conversationHistory.length;
    log.scrollTop = log.scrollHeight;
}

function createElementFromHTML(html) {
    const template = document.createElement("template");
    template.innerHTML = html.trim();
    return template.content.firstChild;
}

/* ================= 打字机效果 ================= */
let typingTimer = null;
let typingIndex = -1;       // 正在打字的 conversationHistory 索引
let typingResolver = null;  // 打字完成 Promise 的 resolve

// 对指定条目启动逐字打字效果，返回 Promise（打字完成或被跳过时 resolve）
function startTypewriter(index) {
    stopTypewriter();
    const log = document.getElementById("gameLog");
    const entries = log.querySelectorAll(".log-entry");
    const entry = entries[index];
    if (!entry) return Promise.resolve();
    const narrativeEl = entry.querySelector(".narrative");
    const data = conversationHistory[index];
    const fullText = data.narrative || "";
    if (!fullText) return Promise.resolve();

    // 清空容器，进入打字状态
    narrativeEl.innerHTML = "";
    narrativeEl.classList.add("typing");
    log.classList.add("typing-active");
    typingIndex = index;

    return new Promise(resolve => {
        typingResolver = resolve;
        const chars = Array.from(fullText);  // Array.from 正确处理 emoji / 代理对
        let i = 0;

        function typeNext() {
            if (i >= chars.length) {
                finishTyping();
                return;
            }
            const ch = chars[i];
            // 打字过程中用纯文本（避免高亮在物品名被截断时闪烁）
            narrativeEl.textContent = chars.slice(0, i + 1).join("");
            i++;
            log.scrollTop = log.scrollHeight;

            // 标点处停顿，更接近阅读节奏
            let delay = 28;
            if ("。！？…".includes(ch)) delay = 170;
            else if ("，、；：".includes(ch)) delay = 85;
            else if (ch === "\n") delay = 110;
            else if (ch === "「" || ch === "」" || ch === '"' ) delay = 50;
            typingTimer = setTimeout(typeNext, delay);
        }
        typeNext();
    });
}

// 结束打字：恢复完整文本（含高亮），清理状态并 resolve
function finishTyping() {
    if (typingTimer) { clearTimeout(typingTimer); typingTimer = null; }
    if (typingIndex >= 0 && conversationHistory[typingIndex]) {
        const log = document.getElementById("gameLog");
        const entries = log.querySelectorAll(".log-entry");
        const entry = entries[typingIndex];
        if (entry) {
            const narrativeEl = entry.querySelector(".narrative");
            const data = conversationHistory[typingIndex];
            const fullText = data.narrative || "";
            // 完成后替换为带物品高亮的 HTML
            narrativeEl.innerHTML = data.isWarning ? escapeHtml(fullText) : highlightItems(fullText);
            narrativeEl.classList.remove("typing");
        }
        log.classList.remove("typing-active");
    }
    typingIndex = -1;
    if (typingResolver) {
        const r = typingResolver;
        typingResolver = null;
        r();
    }
}

// 跳过当前打字（玩家点击日志区或发起新输入时调用）
function skipTypewriter() {
    if (typingIndex >= 0) finishTyping();
}

// 强制停止但不 resolve（用于切换世界/加载存档等场景，避免触发旧回调）
function stopTypewriter() {
    if (typingTimer) { clearTimeout(typingTimer); typingTimer = null; }
    if (typingIndex >= 0) {
        const log = document.getElementById("gameLog");
        const entries = log.querySelectorAll(".log-entry");
        const entry = entries[typingIndex];
        if (entry) entry.querySelector(".narrative")?.classList.remove("typing");
        log.classList.remove("typing-active");
    }
    typingIndex = -1;
    typingResolver = null;
}

function renderChoices(choices) {
    currentChoices = choices || [];
    const area = document.getElementById("choicesArea");
    if (!choices || choices.length === 0) {
        area.innerHTML = "";
        return;
    }
    area.innerHTML = choices.map((c, i) => `<button class="choice-chip" onclick="chooseOption(${i})">${escapeHtml(c.text)}</button>`).join("");
}

/* ================ CRPG: 战斗面板渲染 ================ */
function renderCombatPanel() {
    const panel = document.getElementById("combatPanel");
    if (!panel) return;

    const inCombat = gameState && gameState.combat_stats && gameState.combat_stats.in_combat;
    const enemies = gameState && gameState.combat_stats ? gameState.combat_stats.enemies : null;

    if (!inCombat || !enemies || enemies.length === 0) {
        panel.classList.remove("show");
        if (typeof updateTopPanelPlaceholder === "function") updateTopPanelPlaceholder();
        return;
    }

    panel.classList.add("show");
    // ★ 地图与战斗面板互斥：战斗时隐藏地图
    var mapEl = document.getElementById("mapContainer");
    if (mapEl) mapEl.classList.remove("show");
    if (typeof updateTopPanelPlaceholder === "function") updateTopPanelPlaceholder();

    const round = gameState.combat_stats.combat_round || 1;
    document.getElementById("combatRoundLabel").textContent = "回合 " + round;

    const enemyHtml = enemies.map(function(enemy) {
        const dead = enemy.hp <= 0;
        const hpPct = enemy.maxHp > 0 ? (enemy.hp / enemy.maxHp * 100) : 0;
        const barClass = hpPct < 30 ? "low" : "";
        return '<div class="enemy-card' + (dead ? ' dead' : '') + '">'
            + '<span class="enemy-name' + (dead ? ' dead-text' : '') + '">' + escapeHtml(enemy.name) + '</span>'
            + '<div class="enemy-info">'
            + '<div class="enemy-hp-text">HP ' + enemy.hp + '/' + enemy.maxHp + '</div>'
            + '<div class="enemy-hp-bar"><div class="' + barClass + '" style="width:' + hpPct + '%;"></div></div>'
            + '</div>'
            + '<span class="enemy-ac">AC ' + enemy.ac + '</span>'
            + '</div>';
    }).join("");

    document.getElementById("enemyList").innerHTML = enemyHtml;

    const hint = document.getElementById("combatHint");
    if (hint) {
        hint.textContent = "点击下方动作按钮「攻击」或「施法」进行战斗";
    }
    updateTopPanelPlaceholder();
}

/* ================= A5 调试面板（?debug=true 开启）================= */
function initDebugPanel() {
    // 在页面底部插入调试面板
    var panel = document.createElement("div");
    panel.id = "debugPanel";
    panel.style.cssText = "position:fixed;bottom:0;right:0;width:360px;max-height:50vh;overflow-y:auto;z-index:9999;"
        + "background:rgba(20,18,28,0.95);border-left:1px solid var(--card-border);padding:8px 12px;"
        + "font-size:11px;font-family:monospace;color:#aaa;display:none;";
    panel.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">'
        + '<b style="color:#fff;">🛠️ 调试面板</b>'
        + '<button onclick="var p=document.getElementById(\'debugPanel\');p.style.display=\'none\';" style="background:none;border:none;color:#888;cursor:pointer;font-size:14px;">✕</button>'
        + '</div>'
        + '<div id="debugStats" style="margin-bottom:4px;color:#5DCAA5;">缓存命中: -- | 本轮: --ms | 共 -- 轮</div>'
        + '<div id="debugTurnList" style="max-height:40vh;overflow-y:auto;"></div>';
    document.body.appendChild(panel);
    panel.style.display = "block";

    var toggleBtn = document.createElement("button");
    toggleBtn.id = "debugToggleBtn";
    toggleBtn.textContent = "🐛";
    toggleBtn.title = "切换调试面板";
    toggleBtn.style.cssText = "position:fixed;bottom:4px;right:8px;z-index:10000;background:rgba(0,0,0,0.6);"
        + "border:1px solid #555;color:#888;font-size:14px;padding:2px 6px;cursor:pointer;border-radius:4px;";
    toggleBtn.onclick = function() {
        var p = document.getElementById("debugPanel");
        p.style.display = p.style.display === "none" ? "block" : "none";
    };
    document.body.appendChild(toggleBtn);

    // 注册渲染钩子：logTurnStats 之后自动刷新
    var origLogTurn = window.logTurnStats;
    window.logTurnStats = function(hit, miss, total, usage) {
        if (origLogTurn) origLogTurn(hit, miss, total, usage);
        renderDebugPanel();
    };
}

function renderDebugPanel() {
    if (!window._debugMode) return;
    if (typeof debugLog === "undefined" || !debugLog || !debugLog.turns) return;

    var turns = debugLog.turns;
    var stats = document.getElementById("debugStats");
    var list = document.getElementById("debugTurnList");
    if (!stats || !list) return;

    var totalTurns = turns.length;
    var totalCacheHit = 0, totalCacheMiss = 0, totalOutput = 0;
    turns.forEach(function(t) {
        totalCacheHit += t.cacheHitTokens || 0;
        totalCacheMiss += t.cacheMissTokens || 0;
        totalOutput += t.outputTokens || 0;
    });
    var overallHitRate = (totalCacheHit + totalCacheMiss) > 0
        ? (totalCacheHit / (totalCacheHit + totalCacheMiss) * 100).toFixed(1) + "%" : "--";

    stats.innerHTML = '<span>累计命中率: <b style="color:' + (parseFloat(overallHitRate) >= 50 ? '#5DCAA5' : '#EF9F27') + '">' + overallHitRate + '</b></span>'
        + ' | <span>输出: <b>' + (totalOutput / 1000).toFixed(1) + 'K tokens</b></span>'
        + ' | <span>共 <b>' + totalTurns + '</b> 轮</span>';

    var recent = turns.slice(-20).reverse();
    var html = '<table style="width:100%;border-collapse:collapse;">'
        + '<tr style="color:#888;border-bottom:1px solid #333;"><th style="text-align:left;">#</th><th>耗时</th><th>命中率</th><th>输入</th><th>输出</th><th>状态</th></tr>';
    recent.forEach(function(t) {
        var statusColor = t.status === "ok" ? "#5DCAA5" : t.status === "error" ? "#E24B4A" : "#888";
        html += '<tr style="border-bottom:1px solid #222;">'
            + '<td>' + t.turn + '</td>'
            + '<td style="color:#aaa;">' + (t.latencyMs || "--") + '</td>'
            + '<td style="color:' + (parseFloat(t.hitRate) >= 50 ? '#5DCAA5' : '#EF9F27') + ';">' + (t.hitRate || "0") + '</td>'
            + '<td style="color:#aaa;">' + (t.inputTokens || 0) + '</td>'
            + '<td style="color:#aaa;">' + (t.outputTokens || 0) + '</td>'
            + '<td style="color:' + statusColor + ';">' + (t.status || "--") + '</td>'
            + '</tr>';
    });
    html += '</table>';
    list.innerHTML = html;
}

/* ================= 移动端键盘适配 ================= */
function setupMobileKeyboardHandler() {
    if (!window.visualViewport) return; // 桌面浏览器无需处理

    var _lastHeight = window.visualViewport.height;
    var _keyboardOpen = false;
    var _debounceTimer = null;

    function onViewportChange() {
        clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(function() {
            var currentHeight = window.visualViewport.height;
            var heightDiff = Math.abs(currentHeight - _lastHeight);

            // 高度变化超过 150px 才认为是键盘开/关（过滤滚动条抖动）
            if (heightDiff < 80) return;

            _keyboardOpen = currentHeight < _lastHeight;

            // 键盘打开 → 把 body 高度限定为 visualViewport，输入区自然落在底部
            document.body.style.height = currentHeight + "px";

            // 键盘打开时，把 chat log 滚到底部确保输入框可见
            if (_keyboardOpen) {
                var gameLog = document.getElementById("gameLog");
                if (gameLog) {
                    // 等一帧让布局完成，再滚到底部
                    requestAnimationFrame(function() {
                        gameLog.scrollTop = gameLog.scrollHeight;
                    });
                }
            }

            _lastHeight = currentHeight;
        }, 120); // 120ms 防抖，避免连续 resize 抖动
    }

    window.visualViewport.addEventListener("resize", onViewportChange);

    // 额外：输入框获得焦点时主动滚底（部分安卓机型 visualViewport 事件不稳定）
    var inputEl = document.getElementById("playerInput");
    if (inputEl) {
        inputEl.addEventListener("focus", function() {
            requestAnimationFrame(function() {
                var gameLog = document.getElementById("gameLog");
                if (gameLog) gameLog.scrollTop = gameLog.scrollHeight;
                document.body.style.height = window.visualViewport ? window.visualViewport.height + "px" : "";
            });
        });
        inputEl.addEventListener("blur", function() {
            // 键盘关闭后恢复自然高度
            setTimeout(function() {
                if (!document.activeElement || document.activeElement.tagName !== "INPUT") {
                    document.body.style.height = "";
                }
            }, 300);
        });
    }
}

