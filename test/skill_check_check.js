'use strict';
/* 非战斗技能检定逻辑校验：加载真实 dice.js + action-menu.js，验证 talk/use_item/move 接上 resolveSkillCheck（不耗 API）。
   用法：node test/skill_check_check.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = 'C:/Users/guoxiaoyan/WorkBuddy/C项目';

const diceSrc = fs.readFileSync(path.join(ROOT, 'js', 'dice.js'), 'utf8');
const amSrc = fs.readFileSync(path.join(ROOT, 'js', 'action-menu.js'), 'utf8');

const sandbox = {
  console,
  window: {},
  document: { getElementById: () => ({ value: '', setAttribute(){}, removeAttribute(){}, getAttribute(){return null;} }), querySelector: () => null, createElement: () => ({ className:'', id:'', insertBefore(){} }), querySelectorAll: () => [] },
  // 桩：属性调整值
  CombatStats: { getMod: (gs, attr) => ({ strength:2, dexterity:1, constitution:0, intelligence:3, wisdom:1, charisma:2 }[attr] || 0), applyHeal(){}, restoreMana(){} }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(diceSrc + '\n' + amSrc, sandbox, { filename: 'combined.js' });
sandbox.Dice = sandbox.window.Dice; // 浏览器中 window.Dice 即全局 Dice，vm 里需显式暴露

const AM = sandbox.window.ActionMenu;
const gs = { combat_stats: { in_combat: false } };

let pass = true;
function check(name, cond) { console.log((cond ? '✅' : '❌') + ' ' + name); if (!cond) pass = false; }

// talk → 说服(CHA) / dc 13
const r1 = AM.dispatch('talk', gs);
check('交谈→skill_check 动作类型', r1.actionType === 'skill_check');
check('交谈→技能名"说服"', r1.rulesResult.skillName === '说服');
check('交谈→属性 charisma', r1.rulesResult.attrKey === 'charisma');
check('交谈→DC=13', r1.rulesResult.dc === 13);
check('交谈→有成功判定', typeof r1.rulesResult.success === 'boolean');

// use_item → 巧手(DEX) / dc 13
const r2 = AM.dispatch('use_item', gs);
check('物品→技能名"巧手"', r2.rulesResult.skillName === '巧手');
check('物品→属性 dexterity', r2.rulesResult.attrKey === 'dexterity');
check('物品→DC=13', r2.rulesResult.dc === 13);

// move → 体操(DEX) / dc 12
const r3 = AM.dispatch('move', gs);
check('移动→技能名"体操"', r3.rulesResult.skillName === '体操');
check('移动→DC=12', r3.rulesResult.dc === 12);

// buildActionReport 产出非空且含技能名
const rep = AM.buildActionReport(r1);
check('技能检定报告非空', typeof rep === 'string' && rep.length > 0);
check('报告含"说服"与"DC"', rep.includes('说服') && rep.includes('DC'));

// 攻击/施法仍走原逻辑（回归）
const ra = AM.dispatch('attack', gs);
check('攻击→attack 动作类型（未被破坏）', ra.actionType === 'attack');

console.log('\n========== 技能检定校验:', pass ? 'PASS ✅' : 'FAIL ❌', '==========');
process.exit(pass ? 0 : 1);
