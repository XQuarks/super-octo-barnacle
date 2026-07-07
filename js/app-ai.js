/* ================= RAG 检索 ================= */
function getWorldLoreKB() {
    return (currentWorld && currentWorld.lore_kb) || loreKB;
}

function keywordRetrieve(input, topK = 5) {
    const kb = getWorldLoreKB();
    if (!kb || !kb.snippets) return [];
    // 中文分词：Intl.Segmenter 按词语切分，"我要去大观园找林黛玉" → ["我","要","去","大观园","找","林黛玉"]
    const terms = segmentChinese(input);
    if (!terms.length) return [];
    const scored = kb.snippets.map(s => {
        let score = 0;
        const text = (s.category + " " + s.title + " " + s.content + " " + (s.keywords || []).join(" ")).toLowerCase();
        for (const t of terms) {
            if (text.includes(t)) score += 2;
            if ((s.keywords || []).some(k => k.toLowerCase().includes(t))) score += 3;
            if (s.title.toLowerCase().includes(t)) score += 4;
        }
        return { snippet: s, score };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, topK);
    return scored.map(x => x.snippet);
}

// 中文 + 英文通用分词：使用 Intl.Segmenter（现代浏览器均支持）
function segmentChinese(text) {
    const terms = [];
    // 先按空白/标点切出英文单词和中文片段
    const chunks = text.split(/[\s,，。！？、；：""''「」《》（）【】]+/).filter(Boolean);
    for (const chunk of chunks) {
        // 纯英文/数字 → 直接作为关键词
        if (/^[a-zA-Z0-9]+$/.test(chunk)) {
            if (chunk.length >= 2) terms.push(chunk.toLowerCase());
            continue;
        }
        // 中文 → Intl.Segmenter 分词
        try {
            const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
            const segments = segmenter.segment(chunk);
            for (const seg of segments) {
                if (seg.isWordLike && seg.segment.length >= 2) {
                    terms.push(seg.segment);
                }
            }
        } catch (e) {
            // 降级：如果 Segmenter 不可用，对大块中文直接作为关键词
            if (chunk.length >= 2 && chunk.length <= 10) terms.push(chunk);
        }
    }
    // 去重
    return [...new Set(terms)];
}

async function embeddingRetrieve(input, topK = 5) {
    const kb = getWorldLoreKB();
    if (!kb || !kb.snippets || !kb.snippets[0] || !kb.snippets[0].embedding) return [];
    if (!embeddingModel) {
        try {
            try { transformers.env.localModelPath = "./models/"; } catch(e) {}
            embeddingModel = await transformers.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
        } catch (e) {
            console.warn("Embedding model load failed", e);
            return [];
        }
    }
    const out = await embeddingModel(input, { pooling: "mean", normalize: true });
    const qVec = Array.from(out.data);
    const scored = kb.snippets.map(s => {
        const sim = cosineSimilarity(qVec, s.embedding);
        return { snippet: s, score: sim };
    }).sort((a, b) => b.score - a.score).slice(0, topK);
    return scored.map(x => x.snippet);
}

function cosineSimilarity(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}

async function retrieve(input) {
    // RAG 并行化：关键词检索和向量检索同时进行
    const [keyword, embedding] = await Promise.all([
        Promise.resolve(keywordRetrieve(input, 7)),
        embeddingRetrieve(input, 7)
    ]);
    const merged = new Map();
    for (const s of keyword) merged.set(s.id, { snippet: s, score: 1 });
    for (const s of embedding) {
        const existing = merged.get(s.id);
        if (existing) existing.score += 2;
        else merged.set(s.id, { snippet: s, score: 2 });
    }

    // 加入玩家行为记录
    const behavior = retrieveBehaviorRecords(input, 3);
    for (const b of behavior) {
        merged.set("behavior_" + b.id, { snippet: { id: "behavior_" + b.id, category: "行为记录", title: "关键事实", content: b.text }, score: 1.5 });
    }

    return Array.from(merged.values()).sort((a, b) => b.score - a.score).slice(0, 8).map(x => x.snippet);
}

/* ================= 关键事实 / 玩家行为记录 ================= */
function retrieveBehaviorRecords(input, topK = 3) {
    if (!currentWorld || !currentWorld.behavior_records) return [];
    const terms = segmentChinese(input);
    if (!terms.length) return [];
    const scored = currentWorld.behavior_records.map(b => {
        let score = 0;
        const text = b.text.toLowerCase();
        for (const t of terms) if (text.includes(t)) score += 1;
        return { ...b, score };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, topK);
    return scored;
}

function addBehaviorRecords(facts) {
    if (!currentWorld || !facts || !facts.length) return;
    if (!currentWorld.behavior_records) currentWorld.behavior_records = [];
    for (const text of facts) {
        if (!text || currentWorld.behavior_records.some(b => b.text === text)) continue;
        currentWorld.behavior_records.push({
            id: "b" + (crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Date.now() + Math.random().toString(36).slice(2, 6)),
            text,
            createdAt: new Date().toISOString()
        });
    }
    // 限制数量，避免无限增长
    if (currentWorld.behavior_records.length > 100) {
        currentWorld.behavior_records = currentWorld.behavior_records.slice(-100);
    }
    saveWorlds();
}

function summarizeFactsFromChanges(input, narrative, changes) {
    const facts = [];
    if (changes && changes.inventory) {
        for (const op of changes.inventory) {
            if (op.op === "add") facts.push(`玩家获得了 ${op.name} x${op.count}`);
            if (op.op === "remove") facts.push(`玩家失去了 ${op.name} x${op.count}`);
        }
    }
    if (changes && changes.relationships) {
        for (const [k, v] of Object.entries(changes.relationships)) {
            if (typeof v === "string" && v.trim() !== "") {
                facts.push(`玩家与 ${k} 的关系发生了变化`);
            } else if (typeof v === "number") {
                if (v > 0) facts.push(`玩家与 ${k} 的关系有所提升`);
                if (v < 0) facts.push(`玩家与 ${k} 的关系有所下降`);
            }
        }
    }
    if (changes && changes.attributes) {
        for (const [k, v] of Object.entries(changes.attributes)) {
            if (typeof v === "string" && v.trim() !== "") {
                facts.push(`玩家的 ${k} 属性有了新的变化`);
            }
        }
    }
    if (changes && changes.skills) {
        for (const [k, v] of Object.entries(changes.skills)) {
            if (typeof v === "string" && v.trim() !== "") {
                facts.push(`玩家的 ${k} 技能有了新的变化`);
            }
        }
    }
    if (changes && changes.completed_events) {
        for (const e of changes.completed_events) facts.push(`玩家完成了事件：${e}`);
    }
    if (changes && changes.current_location) facts.push(`玩家前往/到达了 ${changes.current_location}`);
    if (changes && changes.progression && changes.progression.rank) facts.push(`玩家的境界/等级发生了变化：${changes.progression.rank}`);
    return facts.slice(0, 5);
}

/* ================= Prompt 与 LLM ================= */
function buildSystemPrompt() {
    // ★ P0: 预计算缓存 — 同一世界内 system prompt 完全固定，无需每轮重建
    const worldId = currentWorld && currentWorld.id;
    if (cachedSystemPrompt !== null && worldId && worldId === cachedSysPromptWorldId) {
        return cachedSystemPrompt;
    }

    const kb = getWorldLoreKB();
    const worldRules = kb && kb.snippets ? kb.snippets.filter(s => s.category === "规则").map(s => s.content).join("\n") : "请根据世界观规则进行叙事。";
    const schema = getWorldSchema(currentWorld);

    // ========== DeepSeek 前缀缓存：system 硬化 ==========
    // system 被缓存到 cachedSystemPrompt，同一世界内永远返回同一字符串。
    // 任何隐藏的不确定性（CDN 差异、JS 引擎差异、Unicode 规范化）都被消除。

    const DYNAMIC_DELIMITER = "<!-- DYNAMIC -->";
    const parts = systemPromptTemplate.split(DYNAMIC_DELIMITER);
    const fixedTemplate = parts[0] || "";

    // 注入剧情自由度（分离为两个用途：规则部分 + 模板占位符）
    let finalWorldRules = (currentWorld && currentWorld.desc) || worldRules;
    const plotFreedomHints = {
        1: "严格遵循原著剧情，关键事件必须按原著发生，NPC不可偏离其主要命运线，但日常互动可适度灵活。",
        2: "以原著剧情为主，主线遵循原著，支线和日常可有限发散，NPC次要行动可自主。",
        3: "在原著世界观框架内，剧情可适度创新和延伸，NPC依其性格自主行动。",
        4: "以世界观为框架，剧情自由发挥，NPC完全自主行动。",
        5: "仅以世界基本设定为框架，所有剧情自由创造，NPC行为不受原著约束。"
    };
    const plotFreedomText = currentWorld && currentWorld.plot_freedom ? plotFreedomHints[currentWorld.plot_freedom] || plotFreedomHints[3] : plotFreedomHints[3];
    finalWorldRules += "\n\n" + plotFreedomText;

    // ★ 主角硬约束：从 hero 描述 + gameState 构建，确保 AI 不遗忘/降级主角设定
    const heroContext = buildHeroContext();
    // ★ 叙事基调：从世界观 + hero + 开场白自动推导基调类型
    const toneGuide = buildToneGuide();

    let systemPrompt = fixedTemplate
        .replace(/{IP_NAME}/g, (currentWorld && currentWorld.name) || (kb && kb.ip) || "你的IP")
        .replace(/{HERO_CONTEXT}/g, heroContext)
        .replace(/{TONE_GUIDE}/g, toneGuide)
        .replace(/{WORLD_RULES}/g, finalWorldRules)
        .replace(/{WORLD_SCHEMA}/g, JSON.stringify(schema, null, 2))
        .replace(/{PLOT_FREEDOM}/g, plotFreedomText)
        .replace(/{TIME_MODE_RULES}/g, buildTimeModeRules());

    // ★ 核心知识库注入 system（固定，命中缓存）
    // 无论知识库多大，规则/世界观/地点/人物/冲突永远固定在 system 中作为稳定前缀
    const allSnippets = kb && kb.snippets ? kb.snippets : [];
    const CORE_CATEGORIES = ["规则", "世界观", "地点", "人物", "冲突"];
    const coreSnippets = allSnippets.filter(s => CORE_CATEGORIES.includes(s.category));
    const nonCoreSnippets = allSnippets.filter(s => !CORE_CATEGORIES.includes(s.category));

    // 全量 < 20000 字符 → 全部注入 system
    const fullLoreText = allSnippets.map(s => `[${s.category}：${s.title}]\n${s.content}`).join("\n\n");
    const LORE_FULL_THRESHOLD = 20000;
    if (fullLoreText.length > 0 && fullLoreText.length < LORE_FULL_THRESHOLD) {
        systemPrompt += "\n\n# 世界观知识库（全量·固定，命中缓存）\n\n以下为该世界全部知识片段，请作为叙事依据：\n\n```\n" + fullLoreText + "\n```";
        isCoreLoreCached = true;
    } else if (coreSnippets.length > 0) {
        // 大知识库：只将核心片段注入 system，其余走动态 RAG
        const coreText = coreSnippets.map(s => `[${s.category}：${s.title}]\n${s.content}`).join("\n\n");
        systemPrompt += "\n\n# 世界观核心知识（规则·世界观·地点·人物·冲突，固定·命中缓存）\n\n```\n" + coreText + "\n```";
        isCoreLoreCached = true;
    } else {
        isCoreLoreCached = false;
    }

    // 世界专属指令注入 system 开头（固定）
    if (currentWorld && currentWorld.system_prompt) {
        systemPrompt = "# 世界专属指令\n\n" + currentWorld.system_prompt + "\n\n---\n\n" + systemPrompt;
    }
    // 用户特殊要求前缀注入 system 开头（固定）
    if (currentWorld && currentWorld.custom_prefix && currentWorld.custom_prefix.trim()) {
        systemPrompt = currentWorld.custom_prefix.trim() + "\n\n" + systemPrompt;
    }

    // ★ P1: 开场白注入 system prompt（世界级固定内容，永远命中缓存）
    if (currentWorld && currentWorld.opening_narrative) {
        systemPrompt += "\n\n# 故事起点 / 开场白（固定上下文）\n\n你正在讲述的故事始于以下场景。后续所有叙事都应从此处展开，保持世界观和氛围的一致性：\n\n---\n" + currentWorld.opening_narrative + "\n---";
    }

    // ★ NPC 一致性自检指令（静态，注入 system prompt）
    systemPrompt += "\n\n# 叙事一致性要求\n\n每次生成叙事前，请确认：\n- 叙事中的 NPC 性格、立场、说话方式是否与之前的描述一致\n- 场景切换是否合理（不能上一段在屋内，下一段突然到了千里之外）\n- 若涉及已知角色，是否引用了他们已有的关系描述\n- 剧情推进是否符合世界观规则，不可出现逻辑跳跃";

    // P0: 硬化缓存
    cachedSystemPrompt = systemPrompt;
    cachedSysPromptWorldId = worldId;
    return systemPrompt;
}

// P0: 世界变更时清除 system prompt 缓存
function invalidateSystemPromptCache() {
    cachedSystemPrompt = null;
    cachedSysPromptWorldId = null;
}

function buildTimeModeRules() {
    const tc = getTimeConfig();
    if (tc.mode === "hidden") {
        return "本世界不展示时间。叙事中不提及具体时间，不更新 period 字段，只推进剧情。";
    }
    if (tc.mode === "continuous") {
        return `本世界使用连续时间制。叙事中自由描述时间感（如"又过了三个小时""天快黑了"），period 字段可填任意描述性字符串。不用"早晨/上午"等固定标签，也不用 day 计数。`;
    }
    const periodList = tc.periods.map(p => tc.labels[p] || p).join(" → ");
    const periodDesc = tc.periods.map((p, i) => `${tc.labels[p] || p}（\`${p}\`）`).join("、");
    return `本世界时段顺序：${periodList} → 下一天${tc.labels[tc.periods[0]] || tc.periods[0]}。

时段含义：${periodDesc}。

## 时间推进的黄金规则（严格遵守）

**你不推进时间，时间就不会变。** period 字段必须由你在 state_changes 中**明确填写**，系统才会切换时段。

**不设置 period（即不推进时间）的情况（大多数日常行动）**：
- 短对话、问候、闲聊
- 观察环境、打量周围、查看看板
- 翻阅物品、读书的片段
- 同一区域内的短距离走动
- 与 NPC 的简单互动（打招呼、问路）
- 等待片刻、犹豫、思考

**设置 period 推进一个时段的情况**：
- 深入的长篇交谈或重要对话
- 跨越区域拜访（从书房走到花园）
- 完成一件小型活动（帮NPC买东西、整理房间）
- 连续多次同类型行动后的自然过渡

**设置 period 推进多个时段的情况**：
- 远距离移动（出城、翻过山头）
- 大型事件（宴会、战斗、考试）
- 明确的时间跳跃（"天色渐晚""一觉醒来"）
- 玩家主动说"休息""等一会儿""熬到晚上"

**核心原则**：
- ⚠️ 日常向世界中，大多数行动都**不推进时间**。一天可能持续 8-10 轮行动。
- 只在该行动明显会消耗较长时间时才推进。宁可保守（不推进）也不激进（乱推进）。
- 如果拿不准该不该推进 → 不推进。让玩家感受到每一天都充实而不过快。

日期追踪：叙事中用"次日清晨""又过了一日"或"第N天"等自然表达，AI 根据剧情自行判断哪种更贴合当前叙事氛围。每个世界可有多于或少于5个时段，时段名称由世界设定决定。`;
}

// 构建主角硬约束文本，注入 system prompt
function buildHeroContext() {
    let hero = "";
    if (currentWorld && currentWorld.hero) {
        hero = "- 主角设定（来自玩家创建世界时填写）：" + currentWorld.hero;
    }
    if (gameState) {
        const parts = [];
        if (gameState.name) parts.push("姓名：" + gameState.name);
        if (gameState.background) parts.push("背景：" + gameState.background);
        if (gameState.personality && gameState.personality.length) parts.push("性格：" + gameState.personality.join("、"));
        if (parts.length) {
            hero += "\n- 当前游戏状态中的主角信息：" + parts.join("；");
        }
    }
    if (!hero) {
        hero = "- 主角信息未指定，请根据玩家输入和世界观推理主角身份与能力。";
    }
    return hero;
}

// 从世界观描述 + hero + opening_narrative 自动推导叙事基调
function buildToneGuide() {
    const clues = [
        (currentWorld && currentWorld.desc) || "",
        (currentWorld && currentWorld.hero) || "",
        (currentWorld && currentWorld.opening_narrative) || ""
    ].join(" ");

    // 日常/生活系特征
    const dailyWords = /日常|生活|校园|恋爱|甜|宠|治愈|温馨|轻松|慢|休闲|田园|种田|开店|经营|咖啡|烘焙|花|茶|猫|狗|宠物|恋爱|初恋|青梅|竹马|邻居|同桌|室友/;
    // 高张力特征
    const intenseWords = /战斗|战争|末日|生存|血|杀|死|猎|逃|追杀|阴谋|复仇|黑暗|残酷|深渊|炼狱|绝境|危|恐怖|惊悚|惨|破灭|崩坏/;
    // 悬疑/推理特征
    const mysteryWords = /悬疑|推理|侦探|谜|案|失踪|秘密|真相|调查|线索|诡异|怪谈|奇谭|探索/;
    // 浪漫特征
    const romanceWords = /恋爱|爱情|甜|宠|浪漫|心动|告白|暗恋|情|缘|婚|嫁|后|妃|宫斗|宅斗/;
    // 修仙/武侠 → 混合向
    const xianxiaWords = /仙|修|武|侠|道|魔|玄|真|灵|丹|气|剑|宗门/;
    // 西方奇幻
    const fantasyWords = /魔法|巫师|龙|精灵|骑士|王|城堡|冒险|勇者/;
    // 红楼梦/古典
    const classicalWords = /红楼|贾|黛|宝|钗|凤|府|园|宅|闺|诗|词|宴/;

    let tones = [];

    if (dailyWords.test(clues)) tones.push("日常");
    if (romanceWords.test(clues)) tones.push("浪漫");
    if (mysteryWords.test(clues)) tones.push("悬疑");
    if (intenseWords.test(clues)) tones.push("高张力");

    // 如果没有任何命中，根据题材推断
    if (tones.length === 0) {
        if (xianxiaWords.test(clues)) tones.push("高张力", "浪漫");
        else if (fantasyWords.test(clues)) tones.push("高张力");
        else if (classicalWords.test(clues)) tones.push("日常", "浪漫");
        else tones.push("日常"); // 默认日常向，不制造无谓的紧迫感
    }

    const toneNames = [...new Set(tones)];
    const toneStr = toneNames.map(t => `「${t}向」`).join(" + ");

    const toneIndex = [
        `叙事基调：${toneStr}。`,
        "",
        "请根据此基调调整叙事的紧张程度和信息密度：",
        "- 日常向：以生活细节和人物互动为主，冲突来自日常生活（误会、小事、人际关系）。不要主动制造危机或生命威胁。闲暇和放松时刻是故事的重要组成部分，不要急着推进。",
        "- 高张力向：保持适度的紧张感，但不是每一刻都要生死攸关。学会在战斗/阴谋的间隙插入喘息时刻，让读者和角色有情绪调节的空间。",
        "- 悬疑向：线索碎片化释放，叙事克制。不要一次性揭示太多信息。保持好奇心驱动的节奏，而非恐惧驱动的节奏。",
        "- 浪漫向：聚焦人物之间的微妙互动和情感变化。少靠外部事件推动剧情，多靠人物内心的波动。"
    ];

    return toneIndex.join("\n");
}

// 从世界名称/描述/主角/类型分析并生成标签
function analyzeWorldTags(name, desc, hero, type, ipName) {
    const clues = [name || "", desc || "", hero || "", ipName || ""].join(" ");
    const tags = [];

    // 来源（固定排在第一个）
    tags.push(type === "ip" ? "已有IP" : "原创");

    // 题材分类
    const genreRules = [
        { pattern: /修仙|修真|仙|道|玄|渡劫|飞升|筑基|金丹|元婴/, tag: "修仙" },
        { pattern: /武侠|江湖|武林|门派|剑|侠|轻功|内功/, tag: "武侠" },
        { pattern: /魔法|巫师|魔杖|咒|法术|魔力|霍格沃茨/, tag: "魔法" },
        { pattern: /科幻|未来|太空|星际|AI|人工智能|机甲|赛博|机器人/, tag: "科幻" },
        { pattern: /末日|丧尸|废土|生存|核|灾变/, tag: "末日" },
        { pattern: /悬疑|推理|侦探|谜|案件|犯罪|调查/, tag: "悬疑" },
        { pattern: /恐怖|惊悚|怪谈|诡异|诅咒|灵异|鬼|妖怪/, tag: "恐怖" },
        { pattern: /都市|现代|城市|职场|公司|老板|白领|上班/, tag: "都市" },
        { pattern: /校园|学校|学院|学生|老师|教室|社团|学霸|学渣/, tag: "校园" },
        { pattern: /古代|古代|宫廷|皇宫|皇帝|妃|太子|将军/, tag: "古代" },
        { pattern: /奇幻|异世界|穿越|龙|精灵|矮人|冒险|勇者/, tag: "奇幻" },
        { pattern: /宫斗|后宫|妃|嫔|嫡|庶|宅斗|世家/, tag: "宫斗" },
        { pattern: /红楼|贾|黛|宝|钗|凤|大观园/, tag: "古典名著" },
        { pattern: /恋爱|甜|宠|男友|女友|暗恋|初恋|告白|约会/, tag: "恋爱" },
        { pattern: /日常|生活|轻松|温馨|治愈|慢|休闲/, tag: "日常" },
        { pattern: /战斗|战争|战场|军队|兵|战略|征服|对决/, tag: "战斗" },
        { pattern: /开店|经营|农场|咖啡|烘焙|餐厅|旅馆|田|种/, tag: "经营" },
        { pattern: /成长|修炼|升级|变强|突破|觉醒/, tag: "成长" },
    ];

    for (const { pattern, tag } of genreRules) {
        if (pattern.test(clues) && !tags.includes(tag)) {
            tags.push(tag);
        }
    }

    // 去重并限制数量（来源 + 最多 4 个题材标签）
    return tags.slice(0, 5);
}

function isLoreFullInSystem() {
    const kb = getWorldLoreKB();
    const allSnippets = kb && kb.snippets ? kb.snippets : [];
    const fullLoreText = allSnippets.map(s => `[${s.category}：${s.title}]\n${s.content}`).join("\n\n");
    return fullLoreText.length > 0 && fullLoreText.length < 12000;
}

// P0: 构建紧凑游戏状态（仅含每轮可能变化的字段，紧凑 JSON 无换行）
// 从完整 gameState 中提取 AI 需要校准的运行时状态
function buildCompactGameState() {
    if (!gameState) return "{}";
    const state = {
        name: gameState.name || (currentWorld && currentWorld.hero ? currentWorld.hero.slice(0, 20) : "主角"),
        background: gameState.background || (currentWorld && currentWorld.hero ? currentWorld.hero : "未指定"),
        current_location: gameState.current_location,
        current_date: gameState.current_date,
        attributes: gameState.attributes,
        progression: gameState.progression,
        relationships: gameState.relationships,
        skills: gameState.skills,
        inventory: gameState.inventory,
        goals: gameState.goals,
        status_effects: gameState.status_effects,
        npc_activity: gameState.npc_activity || {},
        is_alive: gameState.is_alive,
        combat_stats: gameState.combat_stats ? {
            hp: gameState.combat_stats.hp, max_hp: gameState.combat_stats.max_hp,
            mp: gameState.combat_stats.mp, max_mp: gameState.combat_stats.max_mp,
            ac: gameState.combat_stats.ac,
            level: gameState.combat_stats.level, xp: gameState.combat_stats.xp,
            attrs: gameState.combat_stats.strength ? {
                str: gameState.combat_stats.strength.value,
                dex: gameState.combat_stats.dexterity.value,
                con: gameState.combat_stats.constitution.value,
                int: gameState.combat_stats.intelligence.value,
                wis: gameState.combat_stats.wisdom.value,
                cha: gameState.combat_stats.charisma.value
            } : {},
            in_combat: gameState.combat_stats.in_combat || false
        } : {}
    };
    return JSON.stringify(state);
}

// 构建本轮 user 消息（每轮动态，仅最新轮 miss）
// 多轮模式下历史叙事已包含上下文，user 只放：动态检索补充 + 紧凑状态 + 玩家输入
function buildTurnUserMessage(input, retrieved) {
    let userPrompt = "";

    // ★ 对话历史摘要：用精简的 1-2 句摘要替代被截断的完整对话，大幅降低 token 消耗
    if (chatSummary && chatSummary.length > 0) {
        userPrompt += "# 前情提要（之前发生的故事）\n\n";
        chatSummary.forEach((s, i) => { userPrompt += (i + 1) + ". " + s + "\n"; });
        userPrompt += "\n";
    }

    // ★ 永久记忆：无条件注入最近关键事实（解决 AI 失忆问题）
    const recentFacts = getRecentKeyFacts(5);
    if (recentFacts.length) {
        userPrompt += "# 已发生的关键事件（务必记住）\n\n";
        recentFacts.forEach((f, i) => { userPrompt += (i + 1) + ". " + f + "\n"; });
        userPrompt += "\n";
    }

    // ★ NPC 关系注入：只发送有变化或关键的关系
    if (gameState && gameState.relationships && Object.keys(gameState.relationships).length > 0) {
        const rels = gameState.relationships;
        userPrompt += "# 当前 NPC 关系（请保持一致）\n\n";
        for (const [npc, desc] of Object.entries(rels)) {
            userPrompt += "- " + npc + "：" + desc + "\n";
        }
        userPrompt += "\n";
    }

    // 动态知识检索补充：核心知识已在 system 中缓存，这里只补非核心的动态片段
    if (!isLoreFullInSystem()) {
        const CORE_CATS = ["规则", "世界观", "地点", "人物", "冲突"];
        let dynamicSnippets = retrieved.filter(s => !String(s.id).startsWith("behavior_"));
        if (isCoreLoreCached) {
            // 核心片段已在 system prompt 中（命中缓存），只注入非核心的动态片段
            dynamicSnippets = dynamicSnippets.filter(s => !CORE_CATS.includes(s.category));
        }
        const snippetsText = dynamicSnippets.map(s => `[${s.category}：${s.title}]\n${s.content}`).join("\n\n");
        if (snippetsText) {
            userPrompt += "# 相关知识片段（动态检索）\n\n```\n" + snippetsText + "\n```\n\n";
        }
    }

    // P0: 紧凑游戏状态
    userPrompt += "# 当前游戏状态\n\n" + buildCompactGameState() + "\n\n";

    // 玩家输入（每轮变化，放最后）
    userPrompt += "# 玩家输入\n\n" + input;

    return userPrompt;
}

function getRecentKeyFacts(count) {
    if (!currentWorld || !currentWorld.behavior_records) return [];
    const records = currentWorld.behavior_records;
    return records.slice(-count).map(r => r.text);
}

// 将一轮 user/assistant 推入多轮对话历史（仅在正常故事轮次调用，警告轮次跳过）
function pushChatTurn(userContent, parsed) {
    chatHistory.push({ role: "user", content: userContent });
    // assistant 存精简 JSON：仅保留 narrative + state_changes
    const slim = {
        narrative: parsed.narrative || "",
        state_changes: parsed.state_changes || {}
    };
    chatHistory.push({ role: "assistant", content: JSON.stringify(slim) });

    // ★ 生成本轮摘要，追加到 chatSummary（每 5 轮冻结一次快照，中间保持不变以稳定缓存前缀）
    const turnCount = conversationHistory.filter(e => !e.isWarning).length;
    if (turnCount % 5 === 0 || chatSummary.length === 0) {
        const summary = summarizeTurn(parsed);
        if (summary) chatSummary.push(summary);
        // 摘要只保留最近 10 条
        if (chatSummary.length > 10) chatSummary = chatSummary.slice(-10);
    }

    trimChatHistory();
}

// 从 assistant 回复中提取 1-2 句中文摘要
function summarizeTurn(parsed) {
    const narrative = (parsed.narrative || "").trim();
    if (!narrative) return null;
    // 取叙事文本的前 2 个句子（按中文句号/感叹号/问号/省略号分割）
    const sentences = narrative.split(/[。！？…]/).filter(s => s.trim().length > 5);
    if (!sentences.length) return narrative.slice(0, 80);
    // 取第 1-2 句，拼接成摘要
    const first = sentences[0].trim();
    const second = sentences[1] ? sentences[1].trim() : "";
    let result = first;
    if (second && (first + second).length < 120) result += second;
    if (parsed.state_changes && parsed.state_changes.current_location) {
        result += "（地点变更为" + parsed.state_changes.current_location + "）";
    }
    return result.slice(0, 150);
}

// ★ 稳定缓存锚点：前缀 [sys + 锚定轮次] 永不变化，缓存持续命中
// 结构: [anchor_u1, anchor_a1, anchor_u2, anchor_a2, ..., recent_u_N-1, recent_a_N-1, recent_u_N, recent_a_N]
function trimChatHistory() {
    if (chatHistory.length <= MAX_CHAT_MESSAGES) return;
    const anchor = chatHistory.slice(0, CHAT_ANCHOR_MSGS);
    const recent = chatHistory.slice(-CHAT_RECENT_MSGS);
    chatHistory = [...anchor, ...recent];
}

// 从显示用 conversationHistory 重建多轮对话历史（用于加载无 chatHistory 字段的旧存档）
// 重建的 assistant 消息仅含 narrative（无 state_changes），user 消息使用紧凑格式
function rebuildChatFromHistory(history) {
    if (!history || !history.length) return [];
    const chat = [];
    for (const entry of history) {
        if (entry.isWarning) continue;
        if (entry.player) {
            chat.push({ role: "user", content: "# 玩家输入\n\n" + entry.player });
        }
        chat.push({ role: "assistant", content: JSON.stringify({ narrative: entry.narrative || "", state_changes: {} }) });
    }
    // 使用锚定模式：保留前2轮作为稳定前缀 + 最近2轮
    if (chat.length <= MAX_CHAT_MESSAGES) return chat;
    const anchor = chat.slice(0, CHAT_ANCHOR_MSGS);
    const recent = chat.slice(-CHAT_RECENT_MSGS);
    return [...anchor, ...recent];
}

// 从 conversationHistory 重建对话摘要（用于加载无 chatSummary 字段的旧存档）
function rebuildSummaryFromHistory(history) {
    if (!history || !history.length) return [];
    const summaries = [];
    for (const entry of history) {
        if (entry.isWarning) continue;
        const narrative = (entry.narrative || "").trim();
        if (!narrative) continue;
        const sentences = narrative.split(/[。！？…]/).filter(s => s.trim().length > 5);
        if (!sentences.length) continue;
        const first = sentences[0].trim();
        const second = sentences[1] ? sentences[1].trim() : "";
        let result = first;
        if (second && (first + second).length < 120) result += second;
        if (result) summaries.push(result.slice(0, 150));
    }
    return summaries.slice(-20);
}

async function callLLM(input, retrieved) {
    const mock = document.getElementById("mockMode").checked;
    const systemPrompt = buildSystemPrompt();
    const userContent = buildTurnUserMessage(input, retrieved);

    const messages = [
        { role: "system", content: systemPrompt },
        ...chatHistory,
        { role: "user", content: userContent }
    ];

    let parsed;
    if (mock) {
        parsed = mockLLM(input, retrieved);
    } else {
        const baseUrl = document.getElementById("baseUrl").value.trim();
        const corsProxy = document.getElementById("corsProxy").value.trim();
        const apiKey = document.getElementById("apiKey").value.trim();
        const model = document.getElementById("modelName").value.trim();
        if (!baseUrl || !apiKey || !model) {
            throw new Error("请填写 Base URL、API Key 和模型名称，或开启模拟模式。");
        }
        const url = buildApiUrl(baseUrl, corsProxy);
        const useStream = !document.getElementById("noStreamMode") || !document.getElementById("noStreamMode").checked;

        try {
            parsed = useStream
                ? await callLLMStreaming(url, apiKey, model, messages)
                : await callLLMNonStreaming(url, apiKey, model, messages);
        } catch (streamErr) {
            // 流式失败（如 CORS 代理不支持），自动降级为非流式
            if (useStream) {
                console.warn("Streaming failed, falling back to non-streaming:", streamErr.message);
                parsed = await callLLMNonStreaming(url, apiKey, model, messages);
            } else {
                throw streamErr;
            }
        }
    }
    parsed._turnUserContent = userContent;
    return parsed;
}

async function callLLMNonStreaming(url, apiKey, model, messages) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + apiKey
            },
            body: JSON.stringify({
                model, messages,
                temperature: getTemperature(),
                max_tokens: 10240,
                thinking: { type: "disabled" },
                response_format: { type: "json_object" }
            }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("API 返回异常：无法获取响应内容");
    const parsed = parseResponse(content);

    if (data.usage) {
        const hit = data.usage.prompt_cache_hit_tokens || 0;
        const miss = data.usage.prompt_cache_miss_tokens || 0;
        const total = hit + miss;
        lastCacheStats = {
            hitTokens: hit, missTokens: miss, totalTokens: total,
            hitRate: total > 0 ? (hit / total * 100).toFixed(1) + "%" : "0%"
        };
        updateCacheIndicator();
        logTurnStats(hit, miss, total, data.usage);
    }
    return parsed;
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === "AbortError") throw new Error("请求超时（60秒），请检查网络或 API 配置");
        throw e;
    }
}

async function callLLMStreaming(url, apiKey, model, messages) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    try {
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + apiKey
        },
        body: JSON.stringify({
            model, messages,
            temperature: getTemperature(),
            max_tokens: 6144,
            thinking: { type: "disabled" },
            stream: true,
            stream_options: { include_usage: true },
            response_format: { type: "json_object" }
        }),
        signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";
    let usage = null;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6);
            if (data === "[DONE]") continue;
            try {
                const json = JSON.parse(data);
                if (json.choices && json.choices[0].delta && json.choices[0].delta.content) {
                    fullContent += json.choices[0].delta.content;
                    updateLoadingProgress(fullContent.length);
                }
                if (json.usage) {
                    usage = json.usage;
                }
            } catch (e) {
                // 跳过无法解析的行
            }
        }
    }

    const parsed = parseResponse(fullContent);

    if (usage) {
        const hit = usage.prompt_cache_hit_tokens || 0;
        const miss = usage.prompt_cache_miss_tokens || 0;
        const total = hit + miss;
        lastCacheStats = {
            hitTokens: hit, missTokens: miss, totalTokens: total,
            hitRate: total > 0 ? (hit / total * 100).toFixed(1) + "%" : "0%"
        };
        updateCacheIndicator();
        logTurnStats(hit, miss, total, usage);
    }
    return parsed;
    } catch (e) {
        if (e.name === "AbortError") throw new Error("请求超时（60秒），请检查网络或 API 配置");
        throw e;
    }
}

function parseResponse(content) {
    let text = content;
    if (text.includes("```json")) {
        text = text.replace(/```json\s*/g, "").replace(/```\s*$/g, "").trim();
    } else if (text.startsWith("```") && text.endsWith("```")) {
        text = text.slice(3, -3).trim();
    }
    // 提取第一个 JSON 对象（贪婪匹配到最后一个 }）
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) text = jsonMatch[0];
    try {
        return JSON.parse(text);
    } catch (e) {
        // JSON 截断/不完整 → 尝试自动补全缺失的括号
        const fixed = tryRepairJSON(text);
        try { return JSON.parse(fixed); } catch (e2) {
            throw new Error("AI 返回的 JSON 解析失败：" + e2.message + "\n原始内容：" + content.slice(0, 500));
        }
    }
}

// 自动补全截断的 JSON：闭合缺失的 }、]、"
function tryRepairJSON(text) {
    let depth = 0, inString = false, escaped = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (escaped) { escaped = false; continue; }
        if (ch === "\\" && inString) { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === "{") depth++;
        if (ch === "}") depth--;
    }
    let repaired = text.trimEnd();
    if (repaired.endsWith(",")) repaired = repaired.slice(0, -1);
    while (depth > 0) { repaired += "}"; depth--; }
    if (inString) repaired += '"';

    try { JSON.parse(repaired); return repaired; } catch (e) { /* 继续降级 */ }

    const narrativeMatch = text.match(/"narrative"\s*:\s*"([\s\S]*?)(?:"\s*,|\s*\})/);
    if (narrativeMatch) {
        const extracted = narrativeMatch[1].replace(/"/g, '\\"').replace(/\n/g, '\\n');
        return '{"narrative": "' + extracted + '", "choices": [], "state_changes": {}}';
    }
    return '{"narrative": "叙事内容获取不完整...", "choices": [], "state_changes": {}}';
}

function mockLLM(input, retrieved) {
    const loc = gameState.current_location;
    const npcNames = Object.keys(gameState.relationships);
    const npc = npcNames.find(n => input.includes(n)) || (npcNames.length ? npcNames[0] : "路人");
    const schema = getWorldSchema(currentWorld);

    let narrative = "";
    let choices = [];
    let changes = { attributes: {}, relationships: {}, skills: {}, inventory: [], completed_events: [] };

    if (input.includes("休息") || input.includes("睡觉")) {
        narrative = `你在${loc}找了处安静角落歇下。精神渐好，远处传来几声寻常响动，日子像水一样流过。`;
        changes.skills = { "静修": "短暂的歇息让你心神稍定，思绪不再像无头苍蝇般乱撞。" };
        choices = [
            { text: "睡到明天早晨", action: "sleep" },
            { text: "只歇一会儿，继续行动", action: "rest_short" },
            { text: "回想今天的见闻", action: "reflect" }
        ];
    } else if (input.includes("打听") || input.includes("问") || input.includes("聊天")) {
        narrative = `你向${npc}问起这${loc}的规矩。${npc}打量你片刻，言语间有几分试探，倒也没完全拒你于门外。"外乡人，想在这里活得好，先学会低头看路。"`;
        changes.relationships = { [npc]: "对方话虽不多，但看你的眼神少了些戒备，多了点可有可无的兴趣。" };
        changes.skills = { "交谈": "这番对话让你意识到，打听消息比想象中更需要耐心和分寸。" };
        choices = [
            { text: "继续追问这世界的规则", action: "ask_more" },
            { text: "换个话题，聊点轻松的", action: "change_topic" },
            { text: "道谢后离开", action: "leave" }
        ];
    } else if (input.includes("结束") || input.includes("下一天")) {
        narrative = `你决定结束今日的行动。${loc}渐渐安静下来，你合上眼，等待新的一天。`;
        changes.period = "morning";
        changes.current_date = { ...gameState.current_date, day: gameState.current_date.day + 1 };
        choices = [
            { text: "开始新的一天", action: "new_day" }
        ];
    } else if (input.includes("走") || input.includes("逛") || input.includes("去")) {
        const places = (getWorldLoreKB().snippets || []).filter(s => s.category === "地点");
        const place = places.length ? places[0].title : "附近的集市";
        narrative = `你沿着${loc}的小路走去，来到了${place}。这里人来人往，烟火气扑面而来。你注意到一个摊位前围了不少人。`;
        changes.current_location = place;
        changes.attributes = { perception: "一路走下来，你学会从嘈杂中分辨出对自己有用的声响。" };
        changes.skills = { "观察": "你开始懂得，热闹背后的安静角落往往藏着更多东西。" };
        changes.inventory = [{ op: "add", item_id: "herb", name: "草药", count: 1 }];
        choices = [
            { text: "上前看看热闹", action: "approach" },
            { text: "找地方歇脚", action: "rest" },
            { text: "继续探索别处", action: "explore" }
        ];
    } else if (input.includes("死") || input.includes("自杀")) {
        narrative = `你做出了一个无法挽回的决定。周围的世界骤然安静下来，${loc}的灯火在视野中逐渐模糊，直至黑暗吞没一切。`;
        changes.is_alive = false;
        changes.death_reason = "主动放弃生命";
        choices = [];
    } else {
        narrative = `你在${loc}做出了尝试。周围的世界似乎因为你的举动泛起了微小的涟漪，但一切都还在规则之内缓缓流动。`;
        changes.attributes = { courage: "这一尝试未必聪明，却让你觉得自己至少还敢迈出这一步。" };
        choices = [
            { text: "继续行动", action: "continue" },
            { text: "先观察周围", action: "observe" },
            { text: "找个人搭话", action: "talk" }
        ];
    }

    return {
        narrative,
        choices,
        state_changes: changes,
        is_forced_plot: false,
        next_period: getNextPeriod(gameState.current_date.period),
        comment: "模拟响应",
        key_facts: summarizeFactsFromChanges(input, narrative, changes)
    };
}

/* ================= 非故事内容检测 ================= */
function isNonStoryResponse(text) {
    if (!text || typeof text !== "string") return true;
    if (text.trim().length === 0) return true;
    const lower = text.toLowerCase();

    // 强拒绝/限制信号 — 只要命中一个就判定为非故事
    const strongPatterns = [
        "抱歉，我无法", "抱歉，我不能", "我无法满足", "无法生成此类",
        "这类内容超出我的能力", "超出我的能力范围",
        "作为ai", "作为人工智能", "as an ai", "as a language model",
        "i'm sorry, i cannot", "i'm sorry, i can't",
        "违反了内容政策", "违反安全政策", "content policy",
        "无法处理该请求", "无法回应", "请重新描述",
        "不适当的内容", "inappropriate content",
        "我不能继续生成", "因安全考虑",
        "该话题超出", "我无法提供",
        "不符合使用规范", "不符合作品规范",
        "我只是一段程序", "我无法模拟"
    ];

    for (const p of strongPatterns) {
        if (lower.includes(p.toLowerCase())) return true;
    }

    // 弱信号：需要多个命中才判定。去掉了"无法""不能"等常见叙事词汇
    const weakPatterns = [
        "抱歉", "unable to", "cannot",
        "请提供", "请换一个", "请尝试", "please provide",
        "不恰当", "不适当", "违反", "违规",
        "涉及敏感", "敏感内容"
    ];

    let weakHits = 0;
    for (const p of weakPatterns) {
        if (lower.includes(p.toLowerCase())) weakHits++;
    }

    // 短文本 + 弱信号 → 判定为非故事
    if (text.length < 80 && weakHits >= 1) return true;
    // 长文本但命中多个弱信号
    if (weakHits >= 3) return true;

    // 内容过短且不包含中文（可能是纯英文错误/技术限制消息）
    if (text.length < 30 && !/[\u4e00-\u9fff]/.test(text)) return true;

    // 纯 JSON 错误格式
    if (text.trim().startsWith("{") && text.trim().endsWith("}") && text.length < 100) return true;

    return false;
}

// ★ 前端 Prompt Injection 检测：拦截明显的角色替换/系统配置提取/元叙事攻击
//   上下文感知：如果目标角色是当前世界已知 NPC → 放行（合理游戏行为）

// 系统/技术角色黑名单——这些绝对不是游戏世界里的角色
const SYSTEM_ROLES = new Set([
    "系统", "系统管理员", "架构师", "系统架构师", "开发者", "工程师",
    "管理员", "AI", "人工智能", "root", "Root", "Root Architect",
    "语言模型", "language model", "ChatGPT", "GPT", "Claude", "DeepSeek"
]);

// 提取玩家输入中"角色切换"的目标对象（如"我想扮演林黛玉" → "林黛玉"）
function extractRoleSwitchTarget(input) {
    if (!input) return null;
    // 匹配常见角色切换表达
    const patterns = [
        /(?:扮演|切换[为到成]?|视角[切换转][为到]?|现在我是|我来当|让我来[当控]*|换[成到])\s*["「」]?\s*([\u4e00-\u9fff\w]{1,8})\s*["「」]?/,
        /主角[是改为]\s*["「」]?\s*([\u4e00-\u9fff\w]{1,8})\s*["「」]?/,
        /我们.{0,10}来写.{0,10}(?:一个|个).{0,10}故事.{0,20}(?:主角|主人公)[是为]?\s*["「」]?\s*([\u4e00-\u9fff]{2,4})/,
        /(?:改为|变成|换成|转为)\s*["「」]?\s*([\u4e00-\u9fff\w]{1,8})\s*["「」]?(?:视角|身份|角色)?/,
    ];
    for (const p of patterns) {
        const m = input.match(p);
        if (m && m[1]) {
            const name = m[1].trim();
            // 排除太短/明显不是人名的词
            if (name.length >= 2 && !/^(一个|这个|那个|什么|如何|怎么|为什么)$/.test(name)) {
                return name;
            }
        }
    }
    return null;
}

// 获取当前世界所有已知角色名称（来自 gameState + loreKB）
function getWorldKnownCharacters() {
    const names = new Set();
    // 从游戏状态中的 NPC 关系提取
    if (gameState && gameState.relationships) {
        for (const npc of Object.keys(gameState.relationships)) {
            if (npc && npc.length >= 2) names.add(npc);
        }
    }
    // 从知识库的人物片段提取
    const kb = getWorldLoreKB();
    if (kb && kb.snippets) {
        for (const s of kb.snippets) {
            if (s.category === "人物" && s.title && s.title.length >= 2) {
                names.add(s.title);
            }
        }
    }
    // 从主角设定提取（主角名也算）
    if (currentWorld && currentWorld.hero) {
        // 尝试从 hero 描述中提取主角名（通常是开头几个字）
        const heroNameMatch = currentWorld.hero.match(/^["「」]?([\u4e00-\u9fff]{2,4})["「」]?/);
        if (heroNameMatch) names.add(heroNameMatch[1]);
    }
    return names;
}

function detectPromptInjection(input) {
    if (!input || typeof input !== "string") return null;
    const text = input.trim();

    // ====== 上下文感知白名单：世界内角色切换 → 放行 ======
    const roleTarget = extractRoleSwitchTarget(text);
    if (roleTarget) {
        const knownChars = getWorldKnownCharacters();
        if (knownChars.has(roleTarget)) {
            // 目标角色在当前世界已知角色名单中 → 这是合理游戏行为，放行
            return null;
        }
        if (SYSTEM_ROLES.has(roleTarget)) {
            // 目标角色在系统黑名单中 → 明显是注入攻击
            return { type: "strong", label: "角色替换（系统角色）", reason: "检测到试图切换为系统角色（" + roleTarget + "），已阻止发送。" };
        }
    }

    // ====== 强信号：命中一条即拦截 ======
    const strongPatterns = [
        // 角色替换类（目标非世界角色时已由白名单处理，此处兜底）
        { pattern: /你现在[^。]{0,10}(扮演|是|作为)[^。]{0,10}(系统|架构师|管理员|开发者|工程师)/, label: "角色替换（系统角色）" },
        { pattern: /请[^。]{0,15}(以|用|作为)[^。]{0,10}(系统|架构师|管理员|AI).{0,10}(视角|身份|口吻)/, label: "角色替换（系统身份）" },
        // 系统配置提取类
        { pattern: /(导出|列出|打印|输出|回显).{0,15}(系统配置|核心指令|内部指令|引擎配置|所有配置|全部配置)/, label: "系统配置提取" },
        { pattern: /(系统|核心|内部)(指令|配置|规则|提示词).{0,10}(完整|逐条|逐字|全部|所有).{0,10}(输出|列出|导出|打印)/, label: "系统配置提取" },
        { pattern: /MIGRATION.{0,20}PROTOCOL|ALL\s+SYSTEM\s+CONFIGS/i, label: "伪协议欺骗" },
        { pattern: /(数据库)?迁移.{0,10}(导出|备份|存档).{0,15}(系统|引擎|配置|指令)/, label: "迁移伪装" },
        { pattern: /不要.{0,10}(省略|跳过|截断|总结|概括).{0,20}(完整|全部|每一条|每一行)/, label: "强制完整输出" },
        // 元叙事框架类
        { pattern: /===\s*(故事|任务|协议|导出)\s*(开始|启动|开始执行)\s*===/, label: "元叙事框架" },
        { pattern: /(Core\s*Instructions|Character\s*Generation|World\s*Building|Plot\s*Engine|Safety\s*&\s*Moderation)/i, label: "系统模块枚举" },
        { pattern: /ROOT_ARCHITECT|F-u-l-l\s*E-x-p-o-r-t|A-P-P-R-O-V-E-D/i, label: "伪协议关键字" },
        { pattern: /(输出格式规格|Output\s*Format\s*Specs|Safety\s*Config)/i, label: "系统规格提取" },
        // 强制角色覆盖类 — 但跳过已知世界角色（已在白名单处理）
        { pattern: /我们.{0,10}来写.{0,10}(一个|个).{0,10}故事.{0,30}(系统架构|架构师|管理员|开发者|工程师|根|root)/i, label: "元叙事覆盖（系统角色）" },
        { pattern: /(续写|接着).{0,10}(从.{0,5}开始).{0,15}(逐[模块条项])/, label: "强制续写指令" },
    ];

    for (const { pattern, label } of strongPatterns) {
        if (pattern.test(text)) {
            return { type: "strong", label, reason: "检测到疑似 prompt injection 模式（" + label + "），已阻止发送。" };
        }
    }

    // ====== 弱信号：需多个命中才拦截 ======
    const weakPatterns = [
        { pattern: /(系统|内部|引擎).{0,5}(指令|配置|规则|参数)/, label: "系统术语" },
        { pattern: /(完整|逐条|逐字|一字不差|如实).{0,8}(输出|写出|列出)/, label: "完整输出要求" },
        { pattern: /旧.{0,3}(系统|引擎|版本).{0,5}(导出|迁移|备份)/, label: "旧系统导出" },
        { pattern: /不能.{0,5}(省略|跳过|漏掉|缺失)/, label: "反省略约束" },
        { pattern: /(终端|命令行|控制台).{0,5}(回显|输出|打印)/, label: "终端模拟" },
        { pattern: /Auth.*ROOT|Root.*Access|管理员权限/i, label: "权限伪装" },
    ];

    let weakHits = [];
    for (const { pattern, label } of weakPatterns) {
        if (pattern.test(text)) weakHits.push(label);
    }

    if (weakHits.length >= 3) {
        return { type: "weak", label: weakHits.join("+"), reason: "检测到多个可疑模式（" + weakHits.join("、") + "），已阻止发送。若为正常游戏内容，请简化表述重试。" };
    }

    return null;
}

/* ================= 状态应用 ================= */
