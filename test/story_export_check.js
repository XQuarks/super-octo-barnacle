/* 确定性测试：E 项 导出故事（buildStoryExport 纯函数）
 * 不调用任何 API，纯本地 vm 沙箱加载真实源码。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond) {
    if (cond) { pass++; }
    else { fail++; fails.push(name); console.log("  ✗ " + name); }
}

// ---- localStorage / document / window 桩 ----
const store = {};
const localStorageStub = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
};
function makeEl() {
    return {
        innerHTML: "", value: "", textContent: "", style: {}, classList: { add() {}, remove() {} },
        appendChild() {}, removeChild() {}, insertBefore() {}, querySelector() { return null; },
        addEventListener() {}, click() {}, select() {}, focus() {}, scrollTop: 0, scrollHeight: 0,
        getContext() { return null; }, setAttribute() {}, getAttribute() { return null; }
    };
}
const elementCache = {};
const documentStub = {
    getElementById: (id) => (elementCache[id] || (elementCache[id] = makeEl())),
    createElement: () => makeEl(),
    createElementNS: () => makeEl(),
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, body: makeEl(), documentElement: makeEl()
};
const windowStub = {
    addEventListener() {}, location: { href: "" },
    navigator: { clipboard: { writeText: () => Promise.resolve() } }
};

const srcDir = path.join(__dirname, "..", "js");
const files = ["app-core.js", "app-ai.js", "app-game.js", "app-ui.js", "preset-worlds.js"];
const sandbox = {
    console,
    localStorage: localStorageStub,
    document: documentStub,
    window: windowStub,
    navigator: windowStub.navigator,
    setTimeout: () => {}, clearTimeout: () => {},
    setInterval: () => {}, clearInterval: () => {},
    fetch: () => Promise.reject(new Error("no network in test")),
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    Blob: function () {},
    Math, JSON, Date, Object, Array, String, Number, Boolean, RegExp, Error, Promise,
    parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
    requestAnimationFrame: (fn) => fn()
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of files) {
    const code = fs.readFileSync(path.join(srcDir, f), "utf8");
    vm.runInContext(code, sandbox, { filename: f });
}

// ---- 构造一个丰富的测试世界 / 状态 / 历史 ----
const world = {
    id: "w1", name: "雾隐村", hero: "林夜", intro: "群山环抱的村落，常年被薄雾笼罩。",
    note: "灵感来自东方武侠。",
    lore_kb: { ip: "p", snippets: [
        { id: "l1", category: "地理", title: "迷雾森林", content: "村东的森林终年迷雾，入夜更甚。" },
        { id: "l2", category: "势力", title: "影宗", content: "暗中操控村中交易的神秘组织。" }
    ]},
    pinned_facts: [
        { id: "p1", text: "林夜对影宗立下血誓：不破影宗，不归山。", status: "active", source: "ai" },
        { id: "p2", text: "一条已失效的旧誓。", status: "resolved", source: "manual" }
    ],
    quest_board: [
        { id: "qb1", title: "寻回失踪的货郎", faction: "雾隐村", status: "open", desc: "货郎三日前未归。", reward: { currency: { gold: 50 }, reputation: { "雾隐村": 10 } } },
        { id: "qb2", title: "已接的任务不应出现在可接取栏", faction: "影宗", status: "accepted", desc: "x", reward: {} }
    ],
    current_world_events: [
        { type: "rumor", day: 3, text: "镇上传说林夜身怀秘宝。" },
        { type: "env", day: 5, text: "连日阴雨冲毁了南桥。" }
    ]
};

const state = {
    name: "林夜", age: 19, current_location: "雾隐村·酒馆",
    current_date: { day: 9, period: "noon" },
    background: "孤儿，被老猎人养大。", personality: ["沉默", "机敏"],
    progression: { path: "侠客", rank: 3, progress: 65 },
    reputation: 35, tension: 20,
    combat_stats: { level: 4, xp: 120, xp_to_next: 200, hp: 80, max_hp: 100, mp: 30, max_mp: 50, ac: 14, in_combat: false,
        strength: { value: 14, mod: 2 }, dexterity: { value: 16, mod: 3 } },
    status_effects: [{ name: "轻伤", desc: "移动略缓" }],
    currency: { gold: 120, silver: 5 },
    inventory: [
        { item_id: "i1", name: "玄铁剑", count: 1, type: "weapon", slot: "weapon", damage_bonus: 4, desc: "村中铁匠所铸。", equippable: true },
        { item_id: "i2", name: "干粮", count: 3, type: "consumable", slot: "consumable" }
    ],
    equipped: { weapon: "i1" },
    factions: {
        "雾隐村": { reputation: 35, stance: "友善", desc: "村民待他如子。" },
        "影宗": { reputation: -30, stance: "敌对", desc: "暗中敌对。" }
    },
    relationships: { "酒馆老板": "熟人，常赊账。" },
    npc_states: {
        "阿绫": { attitude: 40, mood: "好奇", card: { desc: "村长之女，擅医术。" } }
    },
    active_quests: [
        { id: "qa1", title: "追查货郎下落", faction: "雾隐村", status: "active", desc: "沿南桥线索追查。", reward: { currency: { gold: 50 }, reputation: { "雾隐村": 10 } } },
        { id: "qa2", title: "了断血誓", faction: "影宗", status: "completed", desc: "击败影宗护法。", reward: { reputation: { "影宗": 20 } } }
    ],
    completed_events: ["第3天：击退山贼", "第6天：寻得古剑"],
    acts_log: [
        { act: 1, title: "启程", reason: "冒险开始", day: 1, period: "morning" },
        { act: 3, title: "转折", reason: "货郎失踪引发主线", day: 8, period: "noon" }
    ],
    choice_log: [
        { day: 2, text: "放过山贼头目。", consequence: "山贼暂退，埋下隐患" },
        { day: 4, text: "答应帮阿绫采药。", consequence: "与阿绫关系升温" }
    ]
};

const history = [
    { day: 1, period: "morning", narrative: "林夜在雾中醒来，村口的老槐树沙沙作响。" },
    { day: 1, period: "morning", player: "我走向村口，查看动静。", narrative: "雾里传来脚步声，一个身影渐近。" },
    { day: 9, period: "noon", narrative: "南桥残骸旁，货郎的包袱散落一地。" },
    { day: 9, period: "noon", player: "我蹲下查看包袱。", narrative: "包袱里有一封未寄出的信。" },
    { day: 9, period: "noon", narrative: "系统提示：存档已同步。", isWarning: true }
];

const summary = ["林夜初到雾隐村，卷入货郎失踪谜案。", "第6天寻得古剑，实力大增。"];

// ---- 运行导出 ----
const md = sandbox.buildStoryExport(world, state, history, summary, { exportedAt: "2026-07-08" });

// ---- 断言 ----
ok("标题含世界名与主角", md.indexOf("# 雾隐村 · 冒险纪事") >= 0);
ok("导出日期被 opts.exportedAt 覆盖", md.indexOf("导出日期：2026-07-08") >= 0);
ok("主角行显示 hero", md.indexOf("> 主角：林夜") >= 0);
ok("含世界背景段", md.indexOf("## 1、世界背景") >= 0 && md.indexOf("群山环抱的村落") >= 0);
ok("含作者注", md.indexOf("灵感来自东方武侠") >= 0);
ok("含剧情时间线段", md.indexOf("## 2、剧情时间线") >= 0);
ok("时间线含第3幕行", md.indexOf("第3幕 | 转折") >= 0);
ok("含前情提要段", md.indexOf("## 3、前情提要") >= 0 && md.indexOf("林夜初到雾隐村") >= 0);
ok("含正文段", md.indexOf("正文") >= 0);
ok("正文按下标幕分组(第1幕标题)", md.indexOf("### 第1幕 · 启程") >= 0);
ok("正文按上标幕分组(第3幕标题)", md.indexOf("### 第3幕 · 转折") >= 0);
ok("正文含第1天·早晨", md.indexOf("**第1天 · 早晨**") >= 0);
ok("正文含玩家输入行", md.indexOf("> **你**：我走向村口，查看动静。") >= 0);
ok("正文含旁白", md.indexOf("雾里传来脚步声") >= 0);
ok("系统提示 warning 不进入正文", md.indexOf("存档已同步") < 0);
ok("含重大事件段", md.indexOf("## ") >= 0 && md.indexOf("击退山贼") >= 0);
ok("含世界脉搏段", md.indexOf("世界脉搏") >= 0 && md.indexOf("镇上传说林夜身怀秘宝") >= 0);
ok("含抉择日志段", md.indexOf("抉择日志") >= 0 && md.indexOf("放过山贼头目") >= 0);
ok("含角色档案段", md.indexOf("角色档案") >= 0);
ok("角色含姓名/年龄/地点", md.indexOf("姓名：林夜") >= 0 && md.indexOf("年龄：19") >= 0 && md.indexOf("当前地点：雾隐村·酒馆") >= 0);
ok("角色含进度", md.indexOf("进度 65%") >= 0);
ok("角色含声望张力", md.indexOf("声望 认可 (35)") >= 0 && md.indexOf("张力 20") >= 0);
ok("角色含战斗数值与 HP", md.indexOf("HP 80/100") >= 0 && md.indexOf("AC 14") >= 0);
ok("角色含临时状态", md.indexOf("轻伤") >= 0);
ok("含货币(金币/银币)", md.indexOf("金币 ×120") >= 0 && md.indexOf("银币 ×5") >= 0);
ok("含背包物品与已装备", md.indexOf("玄铁剑") >= 0 && md.indexOf("已装备") >= 0 && md.indexOf("干粮") >= 0);
ok("含阵营声望(友善/敌对)", md.indexOf("雾隐村：友善 (35)") >= 0 && md.indexOf("影宗：敌对 (-30)") >= 0);
ok("含 NPC 关系与档案", md.indexOf("酒馆老板") >= 0 && md.indexOf("阿绫") >= 0 && md.indexOf("村长之女") >= 0);
ok("含世界书段", md.indexOf("世界书") >= 0);
ok("世界书含设定片段", md.indexOf("迷雾森林") >= 0 && md.indexOf("影宗") >= 0);
ok("恒定事实只列 active", md.indexOf("不破影宗，不归山") >= 0 && md.indexOf("一条已失效的旧誓") < 0);
ok("含任务段", md.indexOf("任务") >= 0);
ok("进行中任务含 active", md.indexOf("追查货郎下落") >= 0);
ok("已完成任务标(已完成)", md.indexOf("了断血誓（已完成）") >= 0);
ok("任务板只列 open(不含 accepted)", md.indexOf("寻回失踪的货郎") >= 0 && md.indexOf("已接的任务不应出现在可接取栏") < 0);
ok("任务含奖励渲染", md.indexOf("金币 +50") >= 0 && md.indexOf("雾隐村 声望 +10") >= 0);
ok("结尾含导出署名", md.indexOf("由 Octo 文字冒险引擎导出") >= 0);

// ---- 空安全 ----
const empty = sandbox.buildStoryExport(null, null, null, null, {});
ok("空入参返回标题(未命名世界)", empty.indexOf("# 未命名世界 · 冒险纪事") >= 0);
ok("空入参主角回退无名旅人", empty.indexOf("> 主角：无名旅人") >= 0);
ok("空入参正文含未落笔提示", empty.indexOf("这一程尚未落笔") >= 0);
ok("空入参无章节时间线", empty.indexOf("剧情时间线") < 0);
ok("空入参角色档案仅含姓名回退", empty.indexOf("角色档案") >= 0 && empty.indexOf("姓名：无名旅人") >= 0);

// ---- getWorldSchema 缺失时不报错（纯函数健壮性） ----
const mdNoSchema = sandbox.buildStoryExport(world, { name: "x" }, [], [], {});
ok("缺少 gameState 字段不抛错", typeof mdNoSchema === "string" && mdNoSchema.length > 0);

console.log("\n===== story_export_check =====");
console.log("PASS: " + pass + "   FAIL: " + fail);
if (fail) { console.log("失败的断言："); fails.forEach(f => console.log("  - " + f)); process.exit(1); }
else console.log("全部通过 ✅");
