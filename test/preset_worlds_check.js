/* 预设 IP 库校验测试（vm 沙箱加载真实源码，不耗 API）
 * 覆盖：结构合法、lore 非空、属性键一致、规则集有效、纯叙事无战斗、
 *       canon 硬约束存在、阵营结构、装备引用、迁移删除旧世界/注入新世界。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const sandbox = { Math: Math, Date: Date, JSON: JSON, console: console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, "js/preset-worlds.js"), "utf8"), sandbox);

let pass = 0, fail = 0;
function ok(name, cond) {
    if (cond) { pass++; }
    else { fail++; console.error("  ✗ " + name); }
}

const buildPresetWorlds = sandbox.buildPresetWorlds;
const PRESET_WORLD_FACTORIES = sandbox.PRESET_WORLD_FACTORIES;
ok("buildPresetWorlds 是函数", typeof buildPresetWorlds === "function");
ok("PRESET_WORLD_FACTORIES 是数组(8)", Array.isArray(PRESET_WORLD_FACTORIES) && PRESET_WORLD_FACTORIES.length === 8);

const worlds = buildPresetWorlds();
const EXPECTED_IDS = ["demo_sanguo", "demo_xiyouji", "demo_shuihu", "demo_shanhaijing", "demo_star_relic", "demo_fog_harbor", "demo_cthulhu", "demo_dnd_original"];
ok("生成 8 个世界", worlds.length === 8);
ok("id 顺序正确", JSON.stringify(worlds.map(w => w.id)) === JSON.stringify(EXPECTED_IDS));

const REQUIRED = ["id", "name", "type", "desc", "hero", "ip_name", "tags", "schema",
    "initial_state", "lore_kb", "system_prompt", "opening_narrative", "initial_choices",
    "ruleset_type", "oracle", "fog_of_war", "style_ref", "rule_freedom", "world_freedom", "custom_prefix"];
const VALID_RULESETS = ["dnd", "cthulhu", "scifi", "modern", "narrative", "ai"];
const CANON_MARKERS = ["不可违背", "硬约束", "canon", "世界观硬约束", "核心设定", "核心谜团", "核心意象"];
const ATTR_KEYS = ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"];

worlds.forEach(w => {
    const tag = "[" + w.id + "] ";
    REQUIRED.forEach(f => ok(tag + "含字段 " + f, w[f] !== undefined && w[f] !== null));
    ok(tag + "name 非空", typeof w.name === "string" && w.name.length > 0);
    ok(tag + "ruleset_type 合法", VALID_RULESETS.indexOf(w.ruleset_type) >= 0);
    ok(tag + "oracle 含 enabled/chaos_factor", w.oracle && typeof w.oracle.enabled === "boolean" && typeof w.oracle.chaos_factor === "number");
    ok(tag + "tags 是数组", Array.isArray(w.tags) && w.tags.length > 0);
    ok(tag + "system_prompt 含 canon 约束", CANON_MARKERS.some(m => w.system_prompt.indexOf(m) >= 0));
    ok(tag + "opening_narrative 非空", typeof w.opening_narrative === "string" && w.opening_narrative.length > 20);
    ok(tag + "initial_choices >= 3", Array.isArray(w.initial_choices) && w.initial_choices.length >= 3);
    // lore
    ok(tag + "lore_kb.snippets 非空(>=8)", w.lore_kb && Array.isArray(w.lore_kb.snippets) && w.lore_kb.snippets.length >= 8);
    (w.lore_kb.snippets || []).forEach(s => {
        ok(tag + "snippet " + s.id + " 字段齐全", s.id && s.category && s.title && s.content && Array.isArray(s.keywords));
    });
    // schema vs attributes 键一致
    const attrLabels = Object.keys(w.schema.attribute_labels || {});
    const stateAttrs = Object.keys(w.initial_state.attributes || {});
    ok(tag + "schema.attribute_labels 键 == initial_state.attributes 键",
        attrLabels.length === stateAttrs.length && attrLabels.every(k => stateAttrs.indexOf(k) >= 0));
    // 战斗相关
    if (w.ruleset_type === "narrative" || w.ruleset_type === "cthulhu") {
        ok(tag + "纯叙事世界无 combat_stats", !w.initial_state.combat_stats);
        ok(tag + "纯叙事 fog_of_war 可为 false", typeof w.fog_of_war === "boolean");
    } else {
        const cs = w.initial_state.combat_stats;
        ok(tag + "非叙事世界含 combat_stats", !!cs);
        if (cs) {
            ok(tag + "combat_stats 含 6 项 D20 属性", ATTR_KEYS.every(k => cs[k] && typeof cs[k].value === "number" && typeof cs[k].mod === "number"));
            ok(tag + "combat_stats hp/mp/ac 合理", cs.hp > 0 && cs.max_hp > 0 && typeof cs.ac === "number");
        }
        // 装备引用存在
        if (w.initial_state.equipped) {
            const ids = (w.initial_state.inventory || []).map(i => i.item_id);
            ok(tag + "equipped.weapon 引用库存", !w.initial_state.equipped.weapon || ids.indexOf(w.initial_state.equipped.weapon) >= 0);
            ok(tag + "equipped.armor 引用库存", !w.initial_state.equipped.armor || ids.indexOf(w.initial_state.equipped.armor) >= 0);
        }
    }
    // 阵营结构（若有）
    const facs = w.initial_state.factions;
    if (facs) {
        Object.keys(facs).forEach(fn => {
            const f = facs[fn];
            ok(tag + "阵营 " + fn + " 含 reputation/stance", typeof f.reputation === "number" && typeof f.stance === "string");
        });
    }
    // 货币结构（若有）
    const cur = w.initial_state.currency;
    if (cur) ok(tag + "currency 为对象", typeof cur === "object");
    // 公有领域 IP 特殊校验
    if (w.type === "ip") {
        ok(tag + "IP 世界 ip_name 非空", w.ip_name && w.ip_name.length > 0);
        ok(tag + "IP 世界 tags 含 公有领域IP", w.tags.indexOf("公有领域IP") >= 0);
        ok(tag + "IP 世界含『原文』类 lore", w.lore_kb.snippets.some(s => s.category === "原文"));
    }
    if (w.type === "original") {
        ok(tag + "原创世界 ip_name 为空", w.ip_name === "");
    }
});

// 迁移逻辑：删除旧预设、注入新预设（复刻 loadWorlds 的迁移段，不依赖 DOM/localStorage）
const OLD_PRESET_IDS = ["demo_蒸汽与魔法", "demo_红楼梦", "demo_magic_academy"];
let fakeWorlds = [
    { id: "demo_红楼梦" },            // 旧，应被删
    { id: "demo_magic_academy" },     // 旧，应被删
    { id: "demo_sanguo" },            // 已存在，保留
    { id: "user_custom_1" }           // 用户存档，保留
];
let changed = false;
OLD_PRESET_IDS.forEach(id => {
    if (fakeWorlds.some(w => w.id === id)) { fakeWorlds = fakeWorlds.filter(w => w.id !== id); changed = true; }
});
buildPresetWorlds().forEach(w => {
    if (!fakeWorlds.some(e => e.id === w.id)) { fakeWorlds.push(w); changed = true; }
});
ok("迁移：旧 demo_红楼梦 已删除", !fakeWorlds.some(w => w.id === "demo_红楼梦"));
ok("迁移：旧 demo_magic_academy 已删除", !fakeWorlds.some(w => w.id === "demo_magic_academy"));
ok("迁移：旧 demo_蒸汽与魔法 已删除", !fakeWorlds.some(w => w.id === "demo_蒸汽与魔法"));
ok("迁移：6 个新预设全部注入", EXPECTED_IDS.every(id => fakeWorlds.some(w => w.id === id)));
ok("迁移：用户存档 user_custom_1 保留", fakeWorlds.some(w => w.id === "user_custom_1"));
ok("迁移：changed 为 true", changed === true);

console.log("\n预设 IP 库测试：" + pass + " PASS, " + fail + " FAIL");
process.exit(fail ? 1 : 0);
