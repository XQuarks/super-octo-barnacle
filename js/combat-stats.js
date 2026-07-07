/**
 * 战斗数值管理 — AetherNarrator CRPG
 * 管理 HP/MP/AC/XP/等级及 6 项 D20 属性
 */
window.CombatStats = (function() {
  'use strict';

  var ATTR_NAMES = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];

  /**
   * 计算属性调整值: floor((value - 10) / 2)
   */
  function calcMod(value) {
    return Math.floor((value - 10) / 2);
  }

  /**
   * 获取指定属性的调整值
   */
  function getMod(gameState, attrName) {
    var cs = gameState && gameState.combat_stats;
    if (!cs) return 0;
    var attr = cs[attrName];
    return attr && typeof attr.mod === 'number' ? attr.mod : 0;
  }

  /**
   * 获取属性值
   */
  function getValue(gameState, attrName) {
    var cs = gameState && gameState.combat_stats;
    if (!cs) return 10;
    var attr = cs[attrName];
    return attr && typeof attr.value === 'number' ? attr.value : 10;
  }

  /**
   * 扣血。返回 { newHp, isDead, overkill }
   */
  function applyDamage(gameState, amount) {
    if (!gameState || !gameState.combat_stats) {
      return { newHp: 0, isDead: true, overkill: amount };
    }
    var cs = gameState.combat_stats;
    var oldHp = cs.hp;
    cs.hp = Math.max(0, Math.min(cs.max_hp, cs.hp - amount));
    return {
      newHp: cs.hp,
      isDead: cs.hp <= 0,
      overkill: cs.hp <= 0 ? -(cs.hp) : 0
    };
  }

  /**
   * 回血。返回 { newHp }
   */
  function applyHeal(gameState, amount) {
    if (!gameState || !gameState.combat_stats) return { newHp: 0 };
    var cs = gameState.combat_stats;
    cs.hp = Math.max(0, Math.min(cs.max_hp, cs.hp + amount));
    return { newHp: cs.hp };
  }

  /**
   * 消耗法力。返回 { newMp, success }
   */
  function consumeMana(gameState, amount) {
    if (!gameState || !gameState.combat_stats) return { newMp: 0, success: false };
    var cs = gameState.combat_stats;
    if (cs.mp < amount) return { newMp: cs.mp, success: false };
    cs.mp -= amount;
    return { newMp: cs.mp, success: true };
  }

  /**
   * 恢复法力。返回 { newMp }
   */
  function restoreMana(gameState, amount) {
    if (!gameState || !gameState.combat_stats) return { newMp: 0 };
    var cs = gameState.combat_stats;
    cs.mp = Math.max(0, Math.min(cs.max_mp, cs.mp + amount));
    return { newMp: cs.mp };
  }

  /**
   * 奖励经验。返回 { newXp, leveledUp, newLevel }
   */
  function awardXp(gameState, amount) {
    if (!gameState || !gameState.combat_stats) {
      return { newXp: 0, leveledUp: false, newLevel: 1 };
    }
    var cs = gameState.combat_stats;
    cs.xp = (cs.xp || 0) + amount;
    var leveledUp = false;
    var xpNeeded = cs.xp_to_next || 300;

    while (cs.xp >= xpNeeded) {
      cs.level = (cs.level || 1) + 1;
      cs.xp -= xpNeeded;
      leveledUp = true;
      xpNeeded = Math.floor(cs.xp_to_next * 1.4);
      cs.xp_to_next = xpNeeded;

      var conMod = cs.constitution ? cs.constitution.mod || 0 : 0;
      var hpGain = Math.max(1, Math.floor(Math.random() * 6) + 2 + conMod);
      cs.max_hp += hpGain;
      cs.hp += hpGain;

      var mpGain = Math.max(1, Math.floor(Math.random() * 3) + 1);
      cs.max_mp += mpGain;
      cs.mp += mpGain;
    }

    return { newXp: cs.xp, leveledUp: leveledUp, newLevel: cs.level };
  }

  /**
   * 计算护甲等级
   */
  function calcAc(gameState) {
    if (!gameState || !gameState.combat_stats) return 10;
    var cs = gameState.combat_stats;
    var dexMod = cs.dexterity ? cs.dexterity.mod || 0 : 0;
    var armorBonus = 0;
    if (gameState.equipment && gameState.equipment.body) {
      armorBonus = gameState.equipment.body.acBonus || 0;
    }
    if (gameState.equipment && gameState.equipment.head) {
      armorBonus += gameState.equipment.head.acBonus || 0;
    }
    return 10 + dexMod + armorBonus;
  }

  /**
   * 获取战斗摘要，用于注入 AI 上下文
   */
  function getCombatSummary(gameState) {
    if (!gameState || !gameState.combat_stats) return '';
    var cs = gameState.combat_stats;
    var lines = [];
    lines.push('HP: ' + cs.hp + '/' + cs.max_hp + '  MP: ' + cs.mp + '/' + cs.max_mp + '  AC: ' + cs.ac);
    lines.push('Level: ' + cs.level + '  XP: ' + cs.xp + '/' + cs.xp_to_next);

    ATTR_NAMES.forEach(function(k) {
      var attr = cs[k];
      if (attr) {
        var sign = attr.mod >= 0 ? '+' : '';
        lines.push(k.substring(0,3).toUpperCase() + ': ' + attr.value + ' (' + sign + attr.mod + ')');
      }
    });

    if (cs.in_combat) lines.push('(战斗中)');
    return lines.join('\n');
  }

  /**
   * 创建默认 combat_stats 对象
   */
  function createDefaults(overrides) {
    overrides = overrides || {};
    var defaults = {
      max_hp: 12, hp: 12,
      max_mp: 4,  mp: 4,
      ac: 12,
      level: 1, xp: 0, xp_to_next: 300,
      strength:     { value: 10, mod: 0, desc: '普通人的力气' },
      dexterity:    { value: 10, mod: 0, desc: '动作没有特别灵巧之处' },
      constitution: { value: 10, mod: 0, desc: '体质跟大多数人无异' },
      intelligence: { value: 10, mod: 0, desc: '智力平平' },
      wisdom:       { value: 10, mod: 0, desc: '直觉并不特别敏锐' },
      charisma:     { value: 10, mod: 0, desc: '举手投足间毫无特殊魅力' },
      in_combat: false
    };

    Object.keys(overrides).forEach(function(k) {
      if (k === 'max_hp' || k === 'hp' || k === 'max_mp' || k === 'mp' ||
          k === 'ac' || k === 'level' || k === 'xp' || k === 'xp_to_next' ||
          k === 'in_combat') {
        defaults[k] = overrides[k];
      } else if (ATTR_NAMES.indexOf(k) >= 0 && typeof overrides[k] === 'object') {
        defaults[k] = {
          value: overrides[k].value || 10,
          mod: calcMod(overrides[k].value || 10),
          desc: overrides[k].desc || ''
        };
      }
    });

    return defaults;
  }

  /**
   * 更新单个属性的 value 并重新计算 mod
   */
  function updateAttr(gameState, attrName, newValue, newDesc) {
    if (!gameState || !gameState.combat_stats) return;
    var cs = gameState.combat_stats;
    if (!cs[attrName]) return;
    if (typeof newValue === 'number') {
      cs[attrName].value = newValue;
      cs[attrName].mod = calcMod(newValue);
    }
    if (typeof newDesc === 'string' && newDesc.trim()) {
      cs[attrName].desc = newDesc.trim();
    }
  }

  return {
    calcMod: calcMod,
    getMod: getMod,
    getValue: getValue,
    applyDamage: applyDamage,
    applyHeal: applyHeal,
    consumeMana: consumeMana,
    restoreMana: restoreMana,
    awardXp: awardXp,
    calcAc: calcAc,
    getCombatSummary: getCombatSummary,
    createDefaults: createDefaults,
    updateAttr: updateAttr,
    ATTR_NAMES: ATTR_NAMES
  };
})();
