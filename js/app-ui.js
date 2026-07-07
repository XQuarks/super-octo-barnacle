
/* ================= 初始化 ================= */
async function init() {
    applyTheme();
    initPanelDivider();
    applyFontSize();
    loadConfig();
    loadSaves();

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
                // A1: 为尚未带向量的世界补齐（含示例世界），让混合 RAG 对所有世界生效
                if (typeof worlds !== "undefined" && worlds.length) {
                    for (const w of worlds) {
                        try { await computeEmbeddingsForWorld(w); } catch (e) {}
                    }
                    if (typeof saveWorlds === "function") saveWorlds();
                }
            } catch (e) { console.warn("Embedding model pre-warm failed:", e.message); }
        }, 500);
    }

    // iOS 键盘适配
    if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", () => {
            document.body.style.height = window.visualViewport.height + "px";
        });
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
    worlds = data ? JSON.parse(data) : [
        createMagicAcademyWorld(),
        createHongLouMengWorld()
    ];
    // 迁移：旧世界的清理与新的 demo 注入
    let changed = false;
    // 删除旧的蒸汽与魔法 demo
    if (worlds.some(w => w.id === "demo_蒸汽与魔法")) {
        worlds = worlds.filter(w => w.id !== "demo_蒸汽与魔法");
        changed = true;
    }
    // 注入缺失的 demo 世界
    if (!worlds.some(w => w.id === "demo_红楼梦")) {
        worlds.push(createHongLouMengWorld());
        changed = true;
    }
    if (!worlds.some(w => w.id === "demo_magic_academy")) {
        worlds.push(createMagicAcademyWorld());
        changed = true;
    }
    if (changed) saveWorlds();
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
        initial_choices: []
    };
}

function createHongLouMengWorld() {
    return {
        id: "demo_红楼梦",
        name: "红楼梦 · 大观园",
        type: "ip",
        desc: "清代乾隆年间，金陵四大家族之首的贾府煊赫一时。宁国府与荣国府比邻而居，园林之中，儿女情长、家族兴衰、命运纠葛交织成一部「千红一哭，万艳同悲」的大戏。",
        hero: "贾府中一位身份待定的年轻公子/小姐，寄居荣国府。",
        ip_name: "红楼梦",
        createdAt: new Date().toISOString().split("T")[0],
        tags: ["已有IP", "古典文学", "家族兴衰"],
        schema: {
            progression_label: "情缘",
            progression_path_label: "身份",
            has_skills: true,
            skill_label: "才艺",
            attribute_labels: {
                courage: "胆识", perception: "灵慧", patience: "涵养", luck: "机缘", will: "心性"
            },
            time_periods: { morning: "晨起", forenoon: "午前", afternoon: "午后", evening: "黄昏", night: "入夜" },
            game_over_conditions: ["is_alive === false"]
        },
        initial_state: {
            name: "瑾玉",
            age: 15,
            background: "贾府旁支之后，父母早亡，由贾母作主接入荣国府抚养。自幼聪慧，琴棋书画皆有所涉，但性情敏感，常感寄人篱下之伤。",
            personality: ["聪慧敏感", "多愁善感", "心地纯良"],
            attributes: {
                courage: "你向来胆小，丫鬟们放个炮仗你都要捂耳。但若有人欺辱你亲近之人，你又能鼓起莫名的勇气。",
                perception: "你的眼睛总能捕捉到旁人忽略的细节——丫头们谁和谁走得近了、太太今天嘴角含笑还是暗沉，你总比别人先察觉。",
                patience: "你能在窗下临半天字帖不挪窝，也能为一首残诗翻来覆去琢磨到三更。",
                luck: "命运待你不薄不厚，恰似大观园里一阵穿堂风，不知会吹开哪扇门。",
                will: "心性绵软，凡事容易往心里去。但骨子里又有一股不服的倔劲。"
            },
            progression: { path: "贾府旁支", rank: "寄居", progress: 0 },
            relationships: {
                "贾母": "老太太疼你，说你眉眼间有几分她年轻时的样子。常唤你到跟前说话解闷。",
                "林黛玉": "她是老太太的外孙女，比你早来一年。你们一见如故，她常说你是这府里唯一懂她的人。",
                "贾宝玉": "荣国府的混世魔王，衔玉而生。他待你极好，可你总觉得他看你的眼神里藏着什么说不清的东西。",
                "薛宝钗": "皇商薛家的千金，端庄大方。你敬她事事周全，却也隐隐感到她对你有所保留。",
                "王熙凤": "荣国府的管事奶奶，精明强干。她对你还算客气，可你知道她眼里只有利益。",
                "袭人": "宝玉房里的大丫鬟，温柔体贴。你与她说过几句话，觉得她是个可托付的人。"
            },
            skills: {
                "诗词": "能凑出几首工整的五言七律，偶尔也有惊人之句。黛玉说你灵气有余、火候不足。",
                "琴艺": "能弹几支《平沙落雁》《梅花三弄》，技法尚可但情感还不够沉厚。",
                "书画": "临过几年帖，字迹清秀有余，筋骨不足。",
                "女红": "能绣些简单花样，但绣鸳鸯时总把两只绣得一模一样，被黛玉笑说是个呆子。"
            },
            inventory: [
                { item_id: "jade_pendant", name: "羊脂玉佩", count: 1 },
                { item_id: "poetry_book", name: "诗集手稿", count: 1 },
                { item_id: "silver", name: "碎银", count: 5 }
            ],
            completed_events: [],
            current_location: "荣国府 · 贾母院",
            current_date: { day: 1, period: "morning" },
            goals: [
                { goal_id: "greet_grandma", name: "给贾母请安", type: "完成事件", deadline: { day: 1, period: "morning" }, visible: true },
                { goal_id: "meet_cousins", name: "认识大观园里的兄弟姐妹", type: "关系变化", deadline: { day: 3, period: "night" }, visible: true }
            ],
            status_effects: [],
            npc_activity: { "贾母": "在花厅喝茶歇午", "林黛玉": "在潇湘馆窗前读书", "贾宝玉": "在怡红院与袭人说话", "王熙凤": "在议事厅处理府务", "薛宝钗": "在蘅芜苑做针线" },
            is_alive: true,
            death_reason: null
        },
        lore_kb: {
            ip: "红楼梦",
            snippets: [
                { id: "hlm1", category: "规则", title: "贾府规矩", content: "贾府是金陵四大家族之首，分为宁国府与荣国府。府中等级森严：老太君（贾母）为最高权威，然后是老爷太太、少爷小姐、大丫鬟、小丫鬟、婆子仆役。晨昏定省不可废，逢年过节祭祀、宴请各有规矩。", keywords: ["贾府", "规矩", "等级", "请安"] },
                { id: "hlm2", category: "规则", title: "男女大防", content: "虽是一家人，男女之间仍有内外之别。小姐们不可随意抛头露面，与外人接触须有人陪同。宝玉是例外——贾母特许他住在大观园中与众姐妹为伴。", keywords: ["男女", "内外", "大观园"] },
                { id: "hlm3", category: "规则", title: "世俗与出世", content: "红楼世界有现实与超现实两个层面：一面是贾府的日常起居、官场往来、家族兴衰；另一面是太虚幻境、通灵宝玉、绛珠仙草的宿世之缘。两者交织，不可分割。", keywords: ["太虚幻境", "宿命", "通灵宝玉"] },
                { id: "hlm4", category: "地点", title: "大观园", content: "为迎接贾元春省亲而建，元春省亲后命众姐妹与宝玉搬入居住。园中有潇湘馆（黛玉居所）、蘅芜苑（宝钗居所）、怡红院（宝玉居所）、稻香村、拢翠庵等多处院落。曲径通幽、花木扶疏，是一方世外桃源。", keywords: ["大观园", "潇湘馆", "蘅芜苑", "怡红院"] },
                { id: "hlm5", category: "地点", title: "荣国府", content: "贾母与贾政、王夫人所居。正房、耳房、穿堂、后院层次分明。贾母院在最深处，花厅日常摆着各色点心，丫头婆子往来不绝。", keywords: ["荣国府", "贾母", "贾政"] },
                { id: "hlm6", category: "地点", title: "宁国府", content: "贾珍、尤氏所居。与荣国府仅一墙之隔，格局相似，但风气更奢靡。府中有一座天香楼，常设宴席。", keywords: ["宁国府", "贾珍", "天香楼"] },
                { id: "hlm7", category: "人物", title: "贾宝玉", content: "荣国府贾政之子，衔玉而生。性格叛逆、厌恶仕途经济，却对女儿家极尽温柔。常住大观园怡红院，身边有袭人、晴雯、麝月等一众丫鬟。他与林黛玉青梅竹马、心灵相通，与薛宝钗则有金玉良缘之说。", keywords: ["贾宝玉", "怡红院", "黛玉", "宝钗", "袭人"] },
                { id: "hlm8", category: "人物", title: "林黛玉", content: "贾母外孙女，父母双亡后投奔贾府。才华横溢，诗词冠绝大观园，但体弱多病、性情敏感。居潇湘馆，与宝玉情投意合，却常因小事生隙。前世为绛珠仙草，以泪还神瑛侍者灌溉之恩。", keywords: ["林黛玉", "潇湘馆", "绛珠仙草", "诗词"] },
                { id: "hlm9", category: "人物", title: "薛宝钗", content: "皇商薛家之女，随母兄投奔贾府。端庄大方、处事周全，深得上下欢心。居蘅芜苑，佩戴金锁，与宝玉的通灵宝玉相传是一对「金玉良缘」。", keywords: ["薛宝钗", "蘅芜苑", "金锁", "金玉良缘"] },
                { id: "hlm10", category: "人物", title: "王熙凤", content: "荣国府管家奶奶，贾琏之妻。精明强干、心狠手辣，偌大贾府在她手里运转自如。嘴甜心苦，对下人恩威并施，对利益锱铢必较。人称「凤辣子」。", keywords: ["王熙凤", "管家", "凤辣子"] },
                { id: "hlm11", category: "人物", title: "贾母", content: "贾府最高权威，史老太君。年过七旬，经历了贾府的鼎盛与初显败象。极疼孙子宝玉和外孙女黛玉，是府中真正的定海神针。", keywords: ["贾母", "史老太君", "权威"] },
                { id: "hlm12", category: "人物", title: "其他姐妹", content: "大观园中还有贾迎春（懦弱温和）、贾探春（精明刚烈）、贾惜春（孤僻冷傲）三春姐妹，以及李纨（寡居的珠大奶奶）、史湘云（活泼豪爽的史家小姐）、妙玉（带发修行的拢翠庵主人）等一众女子。", keywords: ["迎春", "探春", "惜春", "湘云", "妙玉"] },
                { id: "hlm13", category: "事件", title: "前世之缘", content: "宝玉前世为赤瑕宫神瑛侍者，黛玉前世为灵河岸绛珠仙草。神瑛侍者以甘露灌溉，绛珠仙草得以久延岁月。终修成女体后，欲以一生之泪偿还灌溉之恩。", keywords: ["前世", "神瑛侍者", "绛珠仙草", "还泪"] },
                { id: "hlm14", category: "物品", title: "通灵宝玉", content: "宝玉出生时口中衔来的一块五彩晶莹的玉石，正面刻着'莫失莫忘，仙寿恒昌'，反面是'一除邪祟，二疗冤疾，三知祸福'。它不仅是宝玉的命根子，也是整部书的灵魂象征。", keywords: ["通灵宝玉", "莫失莫忘"] },
                { id: "hlm15", category: "势力", title: "四大家族", content: "贾、史、王、薛四大家族，祖上皆是勋贵。贾不假，白玉为堂金作马；阿房宫，三百里，住不下金陵一个史；东海缺少白玉床，龙王来请金陵王；丰年好大雪，珍珠如土金如铁。如今的四大家族已显颓势。", keywords: ["四大家族", "贾史王薛", "金陵"] },
                { id: "hlm16", category: "冲突", title: "金玉良缘 vs 木石前盟", content: "宝玉衔通灵宝玉而生，宝钗有金锁，长辈们认为这是天定的「金玉良缘」。但宝玉心中只有黛玉（前世木石前盟），黛玉因此常感不安、以泪试探。这对三角情感是大观园最核心的张力，牵动所有人的关系网。", keywords: ["金玉良缘", "木石前盟", "黛玉", "宝钗", "宝玉", "金锁", "前世"] },
                { id: "hlm17", category: "冲突", title: "仕途经济 vs 性情自由", content: "贾政等长辈期望宝玉走科举仕途之路，但宝玉极度厌恶八股文章和官场应酬，认为那些是「禄蠹」所为。这种价值观冲突是贾府内部的核心矛盾，也影响着宝玉与宝钗（支持仕途）和黛玉（理解宝玉）的关系走向。", keywords: ["仕途", "科举", "禄蠹", "贾政", "宝玉", "自由"] },
                { id: "hlm18", category: "事件", title: "海棠诗社", content: "探春发起海棠诗社，邀请大观园众人到秋爽斋集会。触发条件：白天时段 + 玩家在大观园 + 与探春关系不为冷淡。每位参与者需即兴赋诗，是展示才艺、增进关系的机会。", keywords: ["诗社", "探春", "海棠", "秋爽斋", "诗词", "才艺"] },
                { id: "hlm19", category: "事件", title: "刘姥姥进大观园", content: "乡下老妪刘姥姥带着土产来贾府攀亲。触发条件：第 2-5 天 + 上午时段 + 玩家在荣国府。刘姥姥粗鄙但幽默，她的到来给大观园带来一阵新鲜空气，但也可能引出各人的真实面目。", keywords: ["刘姥姥", "攀亲", "乡下", "土产"] },
                { id: "hlm20", category: "事件", title: "黛玉葬花", content: "暮春时节，黛玉见落花飘零，触景生情，在花冢边葬花边吟诗。触发条件：黄昏时段 + 玩家在大观园 + 与黛玉关系不为冷淡。这是了解黛玉内心世界的最佳时机，也是推动宝黛关系的关键场景。", keywords: ["葬花", "黛玉", "落花", "花冢", "暮春"] }
            ]
        },
        system_prompt: `你是《红楼梦》前八十回世界观的 AI 文字游戏叙事主持人。请严格遵循以下设定：

1. 时间：清代乾隆年间，地点：金陵贾府（宁国府/荣国府）及大观园。不得出现现代物品、观念或用语。
2. 语言风格：模仿曹雪芹的白话章回体，可用简洁雅致的文白夹杂。叙事要含蓄、留白、有诗意。对话需符合人物身份和性格。
3. 硬性约束：
   - 不可篡改原著核心设定的命运走向（如黛玉注定泪尽而亡、宝玉终将出家），但可以在细节上自由发挥。
   - 贾母为最高权威，宝玉不能做违逆贾母之事。
   - 男女大防不可逾越，小姐们不能随意与外人独处。
   - 超自然元素（太虚幻境、通灵宝玉的灵异）可以出现，但要保持神秘感和诗意，不可过度直白。
4. 输出必须是 JSON 格式。`,
        opening_narrative: `这一日正是仲春时节，荣国府里的海棠开得正盛，一阵风过，花瓣簌簌落了满庭。

你站在贾母院的花厅外，手里绞着帕子，心里七上八下的。老太太今早传话说要见你，你本就寄人篱下、处处小心，哪禁得起这般郑重其事的召唤？是福是祸，一时竟也猜不透。

耳边传来小丫鬟银钏的声音："姑娘，老太太请你进去呢。"

你深吸一口气，理了理鬓边碎发，迈步跨进那挂着湘帘的门——`,
        initial_choices: [
            { text: "向贾母恭敬请安，问老太太身子可好", hint: "礼数周全，讨老人家欢心" },
            { text: "悄悄打量屋内还有谁在，心里盘算应对", hint: "先弄清局面，再决定如何说话" },
            { text: "抬眼环顾，被墙上的一幅字画吸引", hint: "被风雅之物触动，或许会引出故事" }
        ],
        behavior_records: [],
        style_ref: "original",
        custom_style: "",
        ruleset_type: "dnd",
        rule_freedom: 2,
        world_freedom: 2,
        custom_prefix: ""
    };
}

function createMagicAcademyWorld() {
    return {
        id: "demo_magic_academy",
        name: "星辉魔法学院",
        type: "original",
        desc: "在大陆中央的翡翠森林深处，矗立着千年魔法学院「星辉」。这里招收所有拥有魔力天赋的少年少女，教授元素魔法、炼金术、星象学和魔兽驯养。学院依山而建，七座塔楼分别代表七大元素学派。对新生而言，这里既是梦想之地，也是初恋萌芽的温床——毕竟，谁不会对共赴星象塔观星的同学心动呢？",
        hero: "刚入学的魔法新生，魔力天赋尚未完全觉醒，对学院的一切充满好奇与期待。",
        ip_name: "",
        createdAt: new Date().toISOString().split("T")[0],
        tags: ["原创", "魔法学院", "恋爱冒险"],
        schema: {
            progression_label: "年级",
            progression_path_label: "学派",
            has_skills: true,
            skill_label: "魔法/课程",
            attribute_labels: { courage: "勇气", perception: "洞察", patience: "专注", luck: "幸运", will: "意志" },
            time_periods: { morning: "早课", forenoon: "上午课", afternoon: "午后", evening: "黄昏", night: "星夜" },
            game_over_conditions: ["is_alive === false"]
        },
        initial_state: {
            name: "新生",
            age: 15,
            background: "普通商人家庭出身，魔力天赋在一次意外中偶然显露，被学院导师发现后破格录取。你对魔法世界几乎一无所知，怀揣着紧张与憧憬踏入了星辉学院的大门。",
            personality: ["好奇", "腼腆", "善良"],
            attributes: {
                courage: "你连主动和人搭话都要深呼吸三次，但骨子里有一股不愿服输的倔劲。",
                perception: "你对周围人的情绪变化异常敏感，能察觉到谁开心、谁在强颜欢笑。",
                patience: "你能在图书馆泡一下午只为弄懂一条咒语，但实操课上三次放不出魔法球，也会急得咬笔头。",
                luck: "你的运气像一枚两面硬币——今天可能捡到一枚稀有魔石，明天可能在楼梯上摔一跤。",
                will: "虽然嘴上说着'我不行'，但每次想放弃的时候，你总能咬咬牙再试一次。"
            },
            progression: { path: "未定", rank: "一年级新生", progress: 0 },
            relationships: {
                "伊莉丝·风语者": "风元素学派的天才少女，银发紫瞳，总是独来独往。在入学仪式上她多看了你一眼，你不知道那意味着什么。",
                "艾伦·炎心": "火元素学派的阳光少年，你的室友，自来熟到令人发指。第一天就把你的名字记错成谐音绰号，你懒得纠正了。",
                "露娜·夜歌": "暗元素学派的学姐，三年级。温柔得像月光，但有点天然呆，经常迷路。她在开学第一天就撞上了你——字面意义上的。",
                "格雷教授": "水元素学派导师，中年儒雅，说话永远像是在念诗。他是第一个发现你魔力天赋的人，对你寄予厚望。",
                "费恩学长": "光元素学派，五年级的学院首席。英俊、温和、成绩全优，是所有新生仰望的存在——但他对谁都一视同仁地温柔，反而更难接近。"
            },
            skills: {
                "基础元素操控": "连一个完整的火苗都点不着，只能搓出几点可怜的火星。",
                "魔法理论": "昨天才领到课本，连目录都没翻完。",
                "炼金术": "你以为炼金术就是往锅里扔材料乱炖，结果差点炸了实验室——还好艾伦拉住了你。",
                "星象学": "你能认出北极星，仅限于此。",
                "魔兽驯养": "你对魔兽唯一的经验是家里养过一只猫。"
            },
            inventory: [
                { item_id: "wand", name: "新生魔杖", count: 1 },
                { item_id: "robe", name: "学院制服", count: 1 },
                { item_id: "textbook", name: "初级魔法理论", count: 1 },
                { item_id: "coin", name: "银币", count: 8 }
            ],
            completed_events: [],
            current_location: "星辉学院 · 中央广场",
            current_date: { day: 1, period: "morning" },
            goals: [
                { goal_id: "sorting", name: "完成学派分院仪式", type: "完成事件", deadline: { day: 1, period: "afternoon" }, visible: true },
                { goal_id: "make_friend", name: "认识一位同学", type: "关系变化", deadline: { day: 3, period: "night" }, visible: true }
            ],
            status_effects: [],
            npc_activity: { "艾伦·炎心": "在宿舍整理行李，等着和你一起去广场", "伊莉丝·风语者": "独自站在广场边缘的白桦树下", "露娜·夜歌": "在图书馆和某个书架之间迷路了", "格雷教授": "在教师席上翻阅新生名册", "费恩学长": "在广场中央协助新生报到" },
            is_alive: true,
            death_reason: null
        },
        lore_kb: {
            ip: "星辉魔法学院",
            snippets: [
                { id: "ma1", category: "规则", title: "魔法基础规则", content: "施法需要魔杖和咒语配合，还需集中精神力。新生在分院前只能施展基础元素魔法。学院内禁止在走廊斗法，违反者罚扫图书馆一周。", keywords: ["魔杖", "咒语", "魔法", "规则", "新生"] },
                { id: "ma2", category: "规则", title: "七大元素学派", content: "学院设有七大学派：风（速度与感知）、火（力量与激情）、水（治疗与变化）、土（防御与坚韧）、光（治愈与守护）、暗（隐匿与幻术）、雷（爆发与控制）。新生分院通过仪式由魔法水晶球判断最适合的学派。", keywords: ["学派", "元素", "风", "火", "水", "土", "光", "暗", "雷", "分院"] },
                { id: "ma3", category: "规则", title: "学院生活", content: "学生按年级分班，每班约20人。学期为一年，分为三阶段：基础期（1-4月）、专精期（5-8月）、考核期（9-12月）。考核不合格可补考一次，再不合格则退学。", keywords: ["学院", "年级", "学期", "考核", "补考"] },
                { id: "ma4", category: "地点", title: "中央广场", content: "学院核心区域，铺着白色魔石地砖，中央是一座巨大的星辉喷泉。每年开学典礼和重要仪式在此举行。周围环绕着食堂、行政楼和公告栏。", keywords: ["广场", "喷泉", "开学", "仪式"] },
                { id: "ma5", category: "地点", title: "七塔", content: "七座魔法塔分别属七大学派。每座塔有自己的风格：风塔轻盈高挑藤蔓缠绕、火塔外墙似有岩浆流淌、水塔有一道不息之泉从塔顶倾泻、光塔通体洁白绽放柔光、暗塔隐在紫色雾霭中、土塔方正敦实如堡垒、雷塔顶端总有电弧闪烁。", keywords: ["塔", "风塔", "火塔", "水塔", "光塔", "暗塔", "土塔", "雷塔"] },
                { id: "ma6", category: "地点", title: "星象塔", content: "学院最高建筑，专用于星象学教学。顶部有巨大的望远镜和露天观星台。传说在流星雨之夜登上星象塔许愿，愿望就会实现——因此这里也是恋人们最钟爱的约会地点。", keywords: ["星象塔", "观星", "流星雨", "许愿", "约会"] },
                { id: "ma7", category: "地点", title: "翡翠森林", content: "环绕学院的原始魔法森林，是魔兽课实践场地和炼金材料的来源地。林中有古老的魔法遗迹和一条会唱歌的清澈溪流。学院规定新生不得独自深入森林。", keywords: ["森林", "翡翠", "魔兽", "炼金", "遗迹"] },
                { id: "ma8", category: "人物", title: "伊莉丝·风语者", content: "风元素学派一年级，银发紫瞳，天才少女，却极度不善社交。日常行程：晨起在风塔顶练习风刃，上午课后在图书馆角落看书，黄昏时独自在翡翠森林边缘散步。她似乎背负着某个家族的秘密。", keywords: ["伊莉丝", "风语者", "风", "银发", "天才"] },
                { id: "ma9", category: "人物", title: "艾伦·炎心", content: "火元素学派一年级，你的室友。阳光开朗、话多、容易激动，是行走的气氛炸弹。日常行程：晚起急急忙忙跑去教室，午休和同学们在广场聊天，夜晚在宿舍练火球术（经常烧到窗帘）。", keywords: ["艾伦", "炎心", "火", "室友"] },
                { id: "ma10", category: "人物", title: "露娜·夜歌", content: "暗元素学派三年级学姐，温柔天然呆。日常行程：上午经常在教学楼迷路向你求救，下午在暗塔研究幻术，夜晚在星象塔顶独自看星星。她对星空的痴迷无人能及。", keywords: ["露娜", "夜歌", "暗", "学姐", "星空"] },
                { id: "ma11", category: "人物", title: "费恩学长", content: "光元素学派五年级，学院首席。完美而温柔，是所有人的榜样。日常行程：早晨在光塔顶冥想，白日在各教室协助教授授课，黄昏时在广场花坛旁看书。他喜欢在花坛边的长椅上安静地读书，偶尔会收下一两封匿名情书，但从未回应过。", keywords: ["费恩", "光", "首席", "学长"] },
                { id: "ma12", category: "人物", title: "格雷教授", content: "水元素学派导师，你的发掘者。为人儒雅温和，但上课时要求严苛。他喜欢在课堂上用诗歌比喻魔法原理。日常在办公室整理旧魔法手稿，常在深夜还能看到他办公室的灯亮着。", keywords: ["格雷", "教授", "水", "导师"] },
                { id: "ma13", category: "冲突", title: "元素学派间的微妙竞争", content: "七大学派表面上和睦，实则暗流涌动。火学派认为光学派软弱、暗学派认为风学派浮躁、土学派嫌水学派多变。但所有学派都一致推崇雷学派最强——雷塔的学生也确实常年霸占学年榜首。这种竞争有时会升级为塔楼间的斗法事件。", keywords: ["学派", "竞争", "冲突", "对立", "斗法"] },
                { id: "ma14", category: "冲突", title: "魔力天赋与社会出身", content: "学院中有两类学生：出身魔法世家的名门之后和像你一样偶然觉醒的普通学生。前者往往傲慢、自带高级魔杖和家传咒语；后者则靠学院给予的基础配备起步。这道隐形的阶级线常常引发摩擦。你的魔力天赋是否能证明——出身不等于上限？", keywords: ["名门", "平民", "阶级", "天赋", "出身"] },
                { id: "ma15", category: "事件", title: "分院仪式", content: "开学典礼上的重头戏。新生轮流触摸魔法水晶球，球体根据天赋显现对应元素的颜色。分院结果可能出乎意料——有时球会呈现两种颜色，意味着跨学派天赋。触发条件：第 1 天上午 + 玩家在中央广场。这是决定你学派归属的关键时刻。", keywords: ["分院", "水晶球", "元素", "学院", "典礼"] },
                { id: "ma16", category: "事件", title: "流星雨之夜", content: "每年入秋的第一个夜晚，星辉学院上空会降下魔法流星雨。传说如果两人一同在星象塔顶观看流星雨并在流星落下时牵手，他们的魔力会产生共鸣。触发条件：第 5-15 天 + 星夜时段 + 玩家在学院 + 与任意角色的关系不为冷淡。这是经典的恋爱事件触发器。", keywords: ["流星雨", "星象塔", "许愿", "牵手", "共鸣", "恋爱"] },
                { id: "ma17", category: "事件", title: "翡翠森林试炼", content: "新生第一学期的期中测试：三人一组进入翡翠森林，寻找指定的魔法植物并在日落前返回。途中可能遭遇幼年魔兽、迷路、或发现古代魔法遗迹。触发条件：第 6-10 天 + 早晨 + 玩家已在某学派。队友由教授分配，可能与好感最高或最低的同学组队。", keywords: ["森林", "试炼", "期中", "魔兽", "队友"] }
            ]
        },
        system_prompt: `你是星辉魔法学院背景的 AI 文字游戏主持人。风格定位：青春校园 + 恋爱冒险。

世界观硬约束：
- 施法需要魔杖和咒语配合，新生不能施展高级魔法。
- 七大元素学派各有特色，分院后不能转学派但可选修其他元素。
- 学院纪律不能公然挑战——私下小动作可以，公开违规会被罚。
- 魔力天赋的发展需要时间沉淀，不可一夜成为顶尖法师。
- 魔法世界存在真实的危险，但学院范围通常安全。

叙事风格：
- 温暖轻快，带有青春期的朦胧感与悸动感。
- 日常对话要轻松自然，恋爱线要含蓄而不直白——更多是微妙的关心、不经意的脸红、夜空下的安静陪伴。
- 魔法描写要有画面感和诗意。
- 允许适当的幽默元素（艾伦是天然的笑点提供者）。`,
        opening_narrative: `九月的晨光穿过翡翠森林的树冠，在白色魔石铺就的广场上洒下斑驳的光影。

你站在这片陌生的开阔地上，手里攥着那封薄薄的录取通知书，上面用银色墨水写着你的名字，下面是一行烫金小字——「欢迎来到星辉魔法学院」。周围是和你一样穿着崭新制服的新生，有人兴奋地议论着即将看到的七座魔法塔，有人紧张地默背着从家里带来的基础咒语。

一阵微风拂过，广场中央的星辉喷泉忽然亮起柔和的蓝光——那是开学典礼即将开始的信号。

正在你踌躇着不知道该往哪走时，一个红发少年从人群中挤过来，大大咧咧地拍了拍你的肩膀：「嘿！你也是新生吧？我叫艾伦·炎心——咦，你这表情，该不会是在紧张吧？别怕，我打听好了，先集合听校长训话，然后就是重头戏——分院仪式！」

他叽里呱啦说了一通，你只来得及勉强记住他的名字。而就在此时，你的余光捕捉到广场边缘的一棵白桦树下，站着一个银色长发的女孩，她正静静望着喷泉，阳光在她的发梢上跳动着细碎的光。`,
        initial_choices: [
            { "text": "对艾伦微笑点头：「谢谢你，我叫……」，向他介绍自己", "hint": "主动结交第一个朋友，友好开局" },
            { "text": "目光被白桦树下的银发女孩吸引，忍不住多看了几眼", "hint": "被神秘气质吸引，可能开启特殊关系线" },
            { "text": "翻看录取通知书，研究上面提到的七大学派介绍", "hint": "理性派，了解世界观后再做选择" }
        ],
        behavior_records: [],
        style_ref: "none",
        custom_style: "",
        ruleset_type: "dnd",
        rule_freedom: 4,
        world_freedom: 4,
        custom_prefix: ""
    };
}

function loadSaves() {
    const data = localStorage.getItem(STORAGE_KEYS.saves);
    saves = data ? JSON.parse(data) : [];
}

function saveWorlds() {
    try {
        // 不持久化片段向量（384 维 embedding），避免 localStorage 膨胀/配额超限；
        // 向量在加载时由 computeEmbeddingsForWorld 重新计算（见 init）。
        localStorage.setItem(STORAGE_KEYS.worlds, JSON.stringify(worlds, (k, v) => (k === "embedding" ? undefined : v)));
    } catch (e) {
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

/**
 * 构建最终 API 请求 URL
 * 如果配置了 CORS 代理，则将请求通过代理转发：
 *   代理URL + /chat/completions 的原始路径
 *   例如：corsProxy=https://proxy.workers.dev → https://proxy.workers.dev/https://api.deepseek.com/chat/completions
 * 如果没有配置代理，直接请求 baseUrl + /chat/completions
 */
function buildApiUrl(baseUrl, corsProxy) {
    const apiPath = baseUrl.replace(/\/$/, "") + "/chat/completions";
    if (corsProxy) {
        return corsProxy.replace(/\/$/, "") + "/" + apiPath;
    }
    return apiPath;
}

/* ================= 世界模板配置 ================= */
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

// 在创建世界弹窗中显示/隐藏「将带入传说」提示
function refreshInheritedLegendUI() {
    const notice = document.getElementById("inheritedLegendNotice");
    if (!notice) return;
    if (pendingInheritedLegend) {
        document.getElementById("inheritedLegendName").textContent =
            pendingInheritedLegend.worldName + "（" + pendingInheritedLegend.reputationTitle + "）";
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
    const hero = document.getElementById("heroDesc").value.trim();
    const ipName = type === "ip" ? document.getElementById("ipName").value.trim() : "";
    const styleRef = getSelectedStyleRef();
    const customStyle = styleRef === "custom" ? document.getElementById("customStyle").value.trim() : "";
    const rulesetType = selectedRuleset || 'dnd';
    const ruleFreedom = parseInt(document.getElementById("ruleFreedom").value);
    const worldFreedom = parseInt(document.getElementById("worldFreedom").value);
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
        const world = {
            id: "w" + Date.now(),
            name,
            type,
            desc,
            hero,
            ip_name: ipName,
            createdAt: new Date().toISOString().split("T")[0],
            tags: analyzeWorldTags(name, desc, hero, type, ipName),
            schema: generated.schema || defaultWorldSchema(name + " " + desc),
            initial_state: generated.initial_state,
            lore_kb: generated.lore_kb,
            // E12：将上一段传说作为彩蛋注入知识库，并挂接引用
            inherited_legend: null,
            opening_narrative: generated.opening_narrative || "",
            initial_choices: generated.initial_choices || [],
            system_prompt: generated.system_prompt,
            behavior_records: narrativeAnchors ? [{ id: "b_anchor_" + Date.now().toString(36), text: "主角叙事锚点：" + narrativeAnchors, createdAt: new Date().toISOString() }] : [],
            narrative_anchors: narrativeAnchors || (generated.initial_state && generated.initial_state.narrative_anchors) || "",
            source_content: sourceFileContent || "",
            style_ref: styleRef,
            custom_style: customStyle,
            ruleset_type: rulesetType,
            rule_freedom: ruleFreedom,
            world_freedom: worldFreedom,
            custom_prefix: customPrefix
        };

        // A1: 为新建世界的知识片段补齐向量（与预计算向量同格式）
        await computeEmbeddingsForWorld(world);

        // E12：将上一段传说作为彩蛋写入知识库，并标记继承引用
        if (pendingInheritedLegend) {
            const leg = pendingInheritedLegend;
            const legHeroName = leg.heroName || "一位无名旅人";
            const legendSnippet = {
                id: "b_legend_" + Date.now().toString(36),
                category: "事件",
                title: "久远传说：" + leg.worldName,
                content: "（彩蛋·前世余音）据古老传闻，曾有一位名为「" + legHeroName + "」的旅人在此世界留下传说——" + leg.summary + "也许在某个角落，仍有人记得这个名字，或在古籍、遗迹中留下过印记。",
                keywords: ["传说", "彩蛋", "前世余音", legHeroName, leg.worldName]
            };
            if (world.lore_kb && Array.isArray(world.lore_kb.snippets)) {
                world.lore_kb.snippets.push(legendSnippet);
            } else {
                world.lore_kb = { ip: world.name, snippets: [legendSnippet] };
            }
            world.inherited_legend = { id: leg.id, worldName: leg.worldName, heroName: leg.heroName, summary: leg.summary };
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
        document.getElementById("heroDesc").value = "";
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

    return {
        schema,
        initial_state,
        lore_kb: { ip: name, snippets: lore_snippets },
        system_prompt,
        opening_narrative
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
            </div>
            <div class="save-actions">
                <button class="save-play-btn" onclick="loadSave('${s.id}')">继续游玩</button>
                <button class="save-del-btn" onclick="deleteSave('${s.id}')">删除</button>
            </div>
        </div>
    `}).join("");
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
        ${currentWorld.ip_name ? `
        <div class="form-group">
            <label>作品名称</label>
            <p style="margin:0;font-size:15px;color:var(--primary);">${currentWorld.ip_name}</p>
        </div>` : ""}
        <div class="form-group">
            <label>世界观描述</label>
            <p style="margin:0;font-size:14px;line-height:1.6;color:var(--text-secondary);">${currentWorld.desc}</p>
        </div>
        ${currentWorld.hero ? `
        <div class="form-group">
            <label>主角设定</label>
            <p style="margin:0;font-size:14px;line-height:1.6;color:var(--text-secondary);">${currentWorld.hero}</p>
        </div>` : ""}
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

    showScreen("gameScreen");
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

    // ★ CRPG: 初始化动作菜单
    if (typeof ActionMenu !== "undefined") {
        ActionMenu.render(gameState);
    }
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
        existing.state = JSON.parse(stateStr);
        existing.history = JSON.parse(cleanHistoryStr);
        existing.chatHistory = cleanChat;
        existing.chatSummary = chatSummary;
    } else {
        saves.unshift({
            id: "s" + Date.now(), worldId: currentWorld.id, worldName: currentWorld.name,
            progress, updatedAt: now,
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
        { key: "profile", label: "属性" },
        { key: "background", label: "背景" },
        { key: "state", label: "状态" },
        { key: "relations", label: "关系" },
        { key: "items", label: "物品" }
    ];
    if (schema.has_skills) {
        tabs.push({ key: "skills", label: schema.skill_label || "技能" });
    }
    tabs.push({ key: "goals", label: "目标" });
    tabs.push({ key: "npc", label: "NPC" });
    tabs.push({ key: "world", label: "世界动态" });
    tabs.push({ key: "log", label: "抉择" });

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
                    <div class="status-section-title">属性</div>
                    <div class="status-card">
                        ${Object.entries(s.attributes).map(([k, v]) => renderTextAttribute(getAttributeLabel(k), v)).join("")}
                    </div>
                </div>
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
                <div class="status-section">
                    <div class="status-section-title">战斗数值</div>
                    <div class="status-card">
                        <div class="row"><span class="label">等级</span><span class="value">Lv.${s.combat_stats.level} (${s.combat_stats.xp}/${s.combat_stats.xp_to_next} XP)</span></div>
                        <div class="stat-bar xp-bar"><div style="width:${s.combat_stats.xp_to_next > 0 ? s.combat_stats.xp / s.combat_stats.xp_to_next * 100 : 0}%; background: var(--primary);"></div></div>
                        <div class="row"><span class="label">生命值 HP</span><span class="value" style="color: var(--danger);">${s.combat_stats.hp} / ${s.combat_stats.max_hp}</span></div>
                        <div class="stat-bar hp-bar"><div style="width:${s.combat_stats.max_hp > 0 ? s.combat_stats.hp / s.combat_stats.max_hp * 100 : 0}%; background: var(--danger);"></div></div>
                        <div class="row"><span class="label">法力值 MP</span><span class="value" style="color: #6BA4D4;">${s.combat_stats.mp} / ${s.combat_stats.max_mp}</span></div>
                        <div class="stat-bar mp-bar"><div style="width:${s.combat_stats.max_mp > 0 ? s.combat_stats.mp / s.combat_stats.max_mp * 100 : 0}%; background: #6BA4D4;"></div></div>
                        <div class="row"><span class="label">护甲 AC</span><span class="value">${s.combat_stats.ac}</span></div>
                        ${s.combat_stats.in_combat ? '<div class="row"><span class="label" style="color: var(--danger);">状态</span><span class="value" style="color: var(--danger);">战斗中</span></div>' : ''}
                    </div>
                </div>
                <div class="status-section">
                    <div class="status-section-title">D20 属性</div>
                    <div class="status-card">
                        ${['strength','dexterity','constitution','intelligence','wisdom','charisma'].map(k => {
                            const attr = s.combat_stats[k];
                            const labels = { strength: '力量 STR', dexterity: '敏捷 DEX', constitution: '体质 CON', intelligence: '智力 INT', wisdom: '感知 WIS', charisma: '魅力 CHA' };
                            if (!attr) return '';
                            const mod = attr.mod >= 0 ? '+' + attr.mod : attr.mod;
                            return '<div class="row"><span class="label">' + labels[k] + '</span><span class="value">' + attr.value + ' (' + mod + ')</span></div>';
                        }).join('')}
                    </div>
                </div>
                ` : ''}
            `;
            break;

        case "background":
            container.innerHTML = `
                <div class="status-section">
                    <div class="status-section-title">出身背景</div>
                    <div class="status-card text-block">${s.background}</div>
                </div>
                <div class="status-section">
                    <div class="status-section-title">性格</div>
                    <div class="status-card">
                        <div class="status-tag-list">
                            ${(s.personality || []).map(p => `<span class="status-tag">${p}</span>`).join("") || '<span class="empty-hint" style="padding:0">未设置</span>'}
                        </div>
                    </div>
                </div>
                <div class="status-section">
                    <div class="status-section-title">已完成事件</div>
                    <div class="status-card">
                        <div class="status-tag-list">
                            ${s.completed_events.length ? s.completed_events.map(e => `<span class="status-tag">${e}</span>`).join("") : '<span class="empty-hint" style="padding:0">暂无</span>'}
                        </div>
                    </div>
                </div>
            `;
            break;

        case "state":
            container.innerHTML = `
                <div class="status-section">
                    <div class="status-section-title">当前状态</div>
                    <div class="status-card">
                        <div class="row"><span class="label">地点</span><span class="value">${s.current_location}</span></div>
                        <div class="row"><span class="label">时间</span><span class="value">第 ${s.current_date.day} 天 · ${getPeriodLabel(s.current_date.period)}</span></div>
                        <div class="row"><span class="label">${schema.progression_label || "等级"}</span><span class="value">${s.progression.rank}</span></div>
                    </div>
                </div>
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
            const relEntries = Object.entries(s.relationships);
            container.innerHTML = `
                <div class="status-section">
                    <div class="status-section-title">人物关系</div>
                    ${relEntries.length ? relEntries.map(([name, value]) => `
                        <div class="status-card">
                            <div class="row"><span class="label">${name}</span></div>
                            <div class="text-block">${renderTextValue(value)}</div>
                        </div>
                    `).join("") : '<div class="empty-hint">暂无人物关系</div>'}
                </div>
            `;
            break;

        case "items":
            container.innerHTML = `
                <div class="status-section">
                    <div class="status-section-title">背包物品</div>
                    ${s.inventory.length ? s.inventory.map(i => `
                        <div class="status-card">
                            <div class="row">
                                <span class="label">${i.name}</span>
                                <span class="value">x${i.count}</span>
                            </div>
                        </div>
                    `).join("") : '<div class="empty-hint">背包空空如也</div>'}
                </div>
            `;
            break;

        case "skills":
            const skillEntries = Object.entries(s.skills || {});
            container.innerHTML = `
                <div class="status-section">
                    <div class="status-section-title">已掌握${schema.skill_label || "技能"}</div>
                    ${skillEntries.length ? skillEntries.map(([name, value]) => `
                        <div class="status-card">
                            <div class="row"><span class="label">${name}</span></div>
                            <div class="text-block">${renderTextValue(value)}</div>
                        </div>
                    `).join("") : '<div class="empty-hint">尚未掌握' + (schema.skill_label || "技能") + '</div>'}
                </div>
            `;
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

        case "npc":
            {
                const npcEntries = Object.entries(s.npc_states || {});
                container.innerHTML = `
                    <div class="status-section">
                        <div class="status-section-title">NPC 档案</div>
                        ${npcEntries.length ? npcEntries.map(([name, ns]) => {
                            const a = typeof ns.attitude === "number" ? ns.attitude : null;
                            const pct = a !== null ? Math.max(0, Math.min(100, (a + 100) / 2)) : 50;
                            const barColor = a !== null && a < 0 ? "var(--danger)" : "var(--primary)";
                            return `<div class="status-card">
                                <div class="row"><span class="label">${name}</span><span class="value">${a !== null ? tierLabel(attitudeTier(a)) + " (" + a + ")" : "—"}</span></div>
                                ${a !== null ? `<div class="stat-bar"><div style="width:${pct}%;background:${barColor}"></div></div>` : ""}
                                ${ns.mood ? `<div class="row"><span class="label">心情</span><span class="value">${ns.mood}</span></div>` : ""}
                                ${ns.catchphrase ? `<div class="row"><span class="label">口头禅</span><span class="value">${ns.catchphrase}</span></div>` : ""}
                                ${ns.speech_style ? `<div class="text-block" style="font-size:12px;color:var(--text-muted)">${ns.speech_style}</div>` : ""}
                                ${ns.secrets && ns.secrets.length ? `<div class="text-block" style="font-size:12px;color:var(--text-muted)">隐秘：${ns.secrets.join("；")}</div>` : ""}
                                ${ns.schedule && Object.keys(ns.schedule).length ? `<div class="text-block" style="font-size:12px;color:var(--text-muted)">日常：${Object.entries(ns.schedule).map(([p,l]) => p + "在" + l).join("，")}</div>` : ""}
                            </div>`;
                        }).join("") : '<div class="empty-hint">暂无 NPC 档案</div>'}
                    </div>`;
            }
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
                container.innerHTML = `
                    ${legendBlock}
                    <div class="status-section">
                        <div class="status-section-title">世界近期动态（世界脉搏）</div>
                        ${evs.length ? evs.slice().reverse().map(e => `<div class="status-card"><div class="row"><span class="label">[${e.type || "动态"}] 第${e.day}天</span></div><div class="text-block">${e.text}</div></div>`).join("") : '<div class="empty-hint">世界暂时风平浪静</div>'}
                    </div>`;
            }
            break;

        case "log":
            {
                const log = s.choice_log || [];
                container.innerHTML = `
                    <div class="status-section">
                        <div class="status-section-title">抉择日志（你做出的每个选择）</div>
                        ${log.length ? log.slice().reverse().map(c => `<div class="status-card"><div class="row"><span class="label">第${c.day}天</span></div><div class="text-block">${c.text}</div>${c.consequence ? `<div class="text-block" style="font-size:12px;color:var(--text-muted)">倾向：${c.consequence}</div>` : ""}</div>`).join("") : '<div class="empty-hint">你还没有做出选择</div>'}
                    </div>`;
            }
            break;
    }
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
        return;
    }

    panel.classList.add("show");

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

