/**
 * 回合制战斗引擎 — AetherNarrator CRPG
 * 状态机驱动的战斗循环，前端规则引擎做判定，AI 做叙事
 *
 * 依赖: js/dice.js, js/combat-stats.js
 *
 * 状态流转:
 *   idle → init(先攻检定) → player_turn → enemy_turn → result_check → player_turn | victory | defeat
 */
window.CombatEngine = (function() {
  'use strict';

  /**
   * 生成随机敌人
   * levelBracket: 难度等级 1=简单 2=普通 3=困难
   * template: 可选预设模板名称，如不指定则随机从 enemyData 中选取
   */
  function spawnEnemy(levelBracket, template) {
    levelBracket = levelBracket || 1;

    if (template) {
      return buildEnemyFromTemplate(template, levelBracket);
    }

    // 随机选择预设敌人
    var pool = [];
    var minLv = Math.max(1, levelBracket - 1);
    var maxLv = levelBracket + 1;

    if (typeof window.ENEMY_DATA !== 'undefined') {
      ENEMY_DATA.forEach(function(e) {
        if (e.level >= minLv && e.level <= maxLv) pool.push(e);
      });
    }

    if (pool.length === 0) {
      // 兜底：生成基础敌人
      return buildFallbackEnemy(levelBracket);
    }

    var pick = pool[Math.floor(Math.random() * pool.length)];
    return buildEnemyFromData(pick, levelBracket);
  }

  function buildEnemyFromData(data, levelBracket) {
    var hpVar = Math.floor(Math.random() * 4) - 2;
    var hp = Math.max(3, (data.base_hp || 8) + hpVar + (levelBracket - 1) * 2);

    return {
      id: 'enemy_' + (typeof genId === "function" ? genId("").slice(0, 16) : Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
      name: data.name || '怪物',
      hp: hp,
      maxHp: hp,
      ac: (data.ac || 11) + Math.floor((levelBracket - 1) / 2),
      xp: (data.xp || 30) + levelBracket * 10,
      stats: {
        str: (data.str || 10) + levelBracket,
        dex: (data.dex || 10) + levelBracket,
        con: (data.con || 10) + levelBracket,
        int: data.int || 8,
        wis: data.wis || 8,
        cha: data.cha || 6
      },
      attacks: data.attacks || [{ name: '爪击', hitBonus: 2, damage: '1d6+1' }],
      loot: data.loot || [],
      desc: data.desc || ''
    };
  }

  function buildFallbackEnemy(levelBracket) {
    var hp = 6 + levelBracket * 3;
    var names = ['地精', '骷髅兵', '野狼', '山贼', '暗影魔'];
    var name = names[Math.min(levelBracket - 1, names.length - 1)] || '怪物';
    return {
      id: 'enemy_' + Date.now(),
      name: name + ' Lv.' + levelBracket,
      hp: hp, maxHp: hp,
      ac: 10 + levelBracket,
      xp: 20 + levelBracket * 15,
      stats: { str: 10 + levelBracket, dex: 10 + levelBracket, con: 10 + levelBracket,
               int: 8, wis: 8, cha: 6 },
      attacks: [{ name: '攻击', hitBonus: 1 + levelBracket, damage: '1d6+' + levelBracket }],
      loot: [],
      desc: ''
    };
  }

  /**
   * 初始化战斗
   * gameState: 游戏状态对象
   * enemies: 敌人数组 [{id, name, hp, maxHp, ac, stats, attacks, xp, loot}]
   * 返回: 战斗摘要对象
   */
  function initCombat(gameState, enemies) {
    if (!gameState || !gameState.combat_stats) return null;

    var cs = gameState.combat_stats;
    cs.in_combat = true;
    cs.enemies = enemies || [];
    cs.combat_round = 1;
    cs.turn_order = ['player'];
    cs.enemies.forEach(function(e) { cs.turn_order.push(e.id); });
    cs.current_turn_index = 0;
    cs.combat_log = [];

    return {
      in_combat: true,
      enemies: cs.enemies,
      round: cs.combat_round,
      playerHp: cs.hp,
      playerMaxHp: cs.max_hp
    };
  }

  /**
   * 结束战斗
   * 返回: { victory: boolean, xpGained: number, loot: array }
   */
  function endCombat(gameState, victory) {
    if (!gameState || !gameState.combat_stats) return null;

    var cs = gameState.combat_stats;
    var result = { victory: victory, xpGained: 0, loot: [], enemiesDefeated: [] };

    if (victory && cs.enemies) {
      cs.enemies.forEach(function(enemy) {
        result.xpGained += enemy.xp || 0;
        result.loot = result.loot.concat(enemy.loot || []);
        result.enemiesDefeated.push(enemy.name);
      });
    }

    cs.in_combat = false;
    cs.enemies = [];
    cs.combat_round = 0;
    cs.turn_order = [];
    cs.current_turn_index = 0;

    return result;
  }

  /**
   * 玩家攻击敌人
   * 返回: 攻击结果对象
   */
  function playerAttack(gameState, enemyId) {
    if (!gameState || !gameState.combat_stats) return null;
    var cs = gameState.combat_stats;
    var enemy = findEnemy(cs, enemyId);
    if (!enemy) return { error: '目标不存在' };

    var strMod = CombatStats.getMod(gameState, 'strength');
    var check = Dice.checkAgainst(strMod, enemy.ac);
    var damage = 0;
    var crit = check.nat20;
    var fumble = check.nat1;

    if (check.success) {
      var dmgRoll = Dice.roll('1d8');
      damage = dmgRoll.total + strMod;
      damage = Math.max(1, damage);
      if (crit) damage *= 2;
    }

    enemy.hp = Math.max(0, enemy.hp - damage);

    var result = {
      action: 'attack',
      actor: 'player',
      target: enemy.name,
      roll: check.roll,
      modifier: strMod,
      total: check.total,
      targetAc: enemy.ac,
      success: check.success,
      crit: crit,
      fumble: fumble,
      damage: damage,
      enemyHp: enemy.hp,
      enemyMaxHp: enemy.maxHp,
      enemyDead: enemy.hp <= 0
    };

    addCombatLog(cs, result);
    return result;
  }

  /**
   * 玩家施法攻击敌人
   */
  function playerCast(gameState, enemyId) {
    if (!gameState || !gameState.combat_stats) return null;
    var cs = gameState.combat_stats;
    var enemy = findEnemy(cs, enemyId);
    if (!enemy) return { error: '目标不存在' };

    var intMod = CombatStats.getMod(gameState, 'intelligence');
    var mpCost = 2;
    var manaCheck = CombatStats.consumeMana(gameState, mpCost);
    if (!manaCheck.success) return { error: '法力不足' };

    var spellDc = 14;
    var check = Dice.checkAgainst(intMod, spellDc);
    var damage = 0;

    if (check.success) {
      var dmgRoll = Dice.roll('2d6');
      damage = dmgRoll.total + intMod;
      damage = Math.max(1, damage);
      if (check.nat20) damage *= 2;
    }

    enemy.hp = Math.max(0, enemy.hp - damage);

    var result = {
      action: 'cast',
      actor: 'player',
      target: enemy.name,
      roll: check.roll,
      modifier: intMod,
      total: check.total,
      spellDc: spellDc,
      success: check.success,
      crit: check.nat20,
      fumble: check.nat1,
      damage: damage,
      mpCost: mpCost,
      enemyHp: enemy.hp,
      enemyMaxHp: enemy.maxHp,
      enemyDead: enemy.hp <= 0
    };

    addCombatLog(cs, result);
    return result;
  }

  /**
   * 敌人回合：AI 选择行动并执行
   * 返回: 行动结果数组
   */
  function processEnemyTurn(gameState) {
    if (!gameState || !gameState.combat_stats) return [];
    var cs = gameState.combat_stats;
    var results = [];

    var aliveEnemies = (cs.enemies || []).filter(function(e) { return e.hp > 0; });

    aliveEnemies.forEach(function(enemy) {
      var attack = enemy.attacks[0] || { name: '攻击', hitBonus: 2, damage: '1d6+1' };
      var hitBonus = attack.hitBonus || 2;
      var playerAc = cs.ac || 12;

      var check = Dice.checkAgainst(hitBonus, playerAc);
      var damage = 0;

      if (check.success) {
        var dmgRoll = Dice.roll(attack.damage || '1d6+1');
        // 解析 "1d6+2" 格式的伤害
        var dmgBonus = 0;
        var dmgMatch = ('' + attack.damage).match(/\+(\d+)/);
        if (dmgMatch) dmgBonus = parseInt(dmgMatch[1]);
        damage = dmgRoll.total + dmgBonus;
        damage = Math.max(1, damage);
        if (check.nat20) damage *= 2;
      }

      CombatStats.applyDamage(gameState, damage);

      var result = {
        action: 'enemy_attack',
        actor: enemy.name,
        target: 'player',
        attackName: attack.name,
        roll: check.roll,
        modifier: hitBonus,
        total: check.total,
        targetAc: playerAc,
        success: check.success,
        crit: check.nat20,
        fumble: check.nat1,
        damage: damage,
        playerHp: cs.hp,
        playerMaxHp: cs.max_hp,
        playerDead: cs.hp <= 0
      };

      results.push(result);
      addCombatLog(cs, result);
    });

    return results;
  }

  /**
   * 推进回合
   * 返回: { phase, results, combatOver, victory, xpGained, enemiesDefeated }
   */
  function advanceTurn(gameState) {
    if (!gameState || !gameState.combat_stats) return { phase: 'error' };
    var cs = gameState.combat_stats;

    if (!cs.in_combat) return { phase: 'not_in_combat' };

    // 获取当前回合者
    var order = cs.turn_order || [];
    var idx = cs.current_turn_index || 0;

    if (idx >= order.length) {
      // 回合结束，开始新回合
      cs.combat_round = (cs.combat_round || 1) + 1;
      cs.current_turn_index = 0;
      idx = 0;
    }

    var current = order[idx];
    var results = [];

    if (current === 'player') {
      return { phase: 'player_turn', awaitingInput: true };
    } else {
      // 敌人回合
      results = processEnemyTurn(gameState);
      cs.current_turn_index = idx + 1;
    }

    // 检查战斗是否结束
    var aliveEnemies = (cs.enemies || []).filter(function(e) { return e.hp > 0; });
    var playerAlive = cs.hp > 0;

    if (aliveEnemies.length === 0 && playerAlive) {
      var endResult = endCombat(gameState, true);
      return {
        phase: 'victory',
        results: results,
        combatOver: true,
        victory: true,
        xpGained: endResult.xpGained,
        enemiesDefeated: endResult.enemiesDefeated
      };
    }

    if (!playerAlive) {
      endCombat(gameState, false);
      return {
        phase: 'defeat',
        results: results,
        combatOver: true,
        victory: false,
        playerDied: true
      };
    }

    return {
      phase: 'enemy_turn_complete',
      results: results,
      combatOver: false,
      round: cs.combat_round,
      playerHp: cs.hp,
      enemies: cs.enemies
    };
  }

  /**
   * 完成玩家回合后的处理
   */
  function completePlayerTurn(gameState, playerActionResult) {
    if (!gameState || !gameState.combat_stats) return null;
    var cs = gameState.combat_stats;

    // 先检查是否有敌人死亡
    var anyDead = cs.enemies.some(function(e) { return e.hp <= 0; });

    // 推进到下一个
    cs.current_turn_index = (cs.current_turn_index || 0) + 1;

    // 如果还有存活敌人且不是全部死完，继续敌人回合
    return advanceTurn(gameState);
  }

  /**
   * 获取当前战斗摘要（用于注入 AI prompt）
   */
  function getCombatReport(gameState) {
    if (!gameState || !gameState.combat_stats) return '';
    var cs = gameState.combat_stats;

    var lines = [];
    lines.push('=== 战斗回合 ' + (cs.combat_round || 1) + ' ===');
    lines.push('玩家 HP: ' + cs.hp + '/' + cs.max_hp + '  MP: ' + cs.mp + '/' + cs.max_mp + '  AC: ' + cs.ac);

    if (cs.enemies) {
      cs.enemies.forEach(function(e) {
        var status = e.hp <= 0 ? ' [已击败]' : '';
        lines.push('敌人: ' + e.name + ' HP: ' + e.hp + '/' + e.maxHp + ' AC: ' + e.ac + status);
      });
    }

    if (cs.combat_log && cs.combat_log.length > 0) {
      lines.push('');
      lines.push('本回合战斗记录:');
      var recent = cs.combat_log.slice(-6); // 最近 6 条
      recent.forEach(function(log) {
        if (log.actor === 'player') {
          var outcome = log.success ? '命中' : '未命中';
          lines.push('  [玩家] ' + outcome + ' ' + log.target + ' (D20=' + log.roll + ' 伤害=' + (log.damage || 0) + ')');
        } else {
          var outcome2 = log.success ? '命中' : '未命中';
          lines.push('  [' + log.actor + '] ' + log.attackName + ' ' + outcome2 + ' (D20=' + log.roll + ' 伤害=' + (log.damage || 0) + ')');
        }
      });
    }

    return lines.join('\n');
  }

  /**
   * 战斗日志 → AI 可读的叙事提示
   */
  function buildCombatNarrativeHint(gameState) {
    if (!gameState || !gameState.combat_stats) return '';
    var cs = gameState.combat_stats;
    var log = cs.combat_log || [];
    if (log.length === 0) return '[战斗开始]';

    var report = getCombatReport(gameState);
    report += '\n\n请根据上述战斗记录生成一段精彩的战斗叙事。描述每一击的细节、双方的攻防态势。如果敌人被击败，描述击败的场面。如果玩家被击中，描述受伤的感觉。';

    return report;
  }

  // ====== 内部辅助 ======

  function findEnemy(cs, enemyId) {
    if (!cs || !cs.enemies) return null;
    for (var i = 0; i < cs.enemies.length; i++) {
      if (cs.enemies[i].id === enemyId) return cs.enemies[i];
    }
    return null;
  }

  function addCombatLog(cs, result) {
    if (!cs) return;
    if (!cs.combat_log) cs.combat_log = [];
    cs.combat_log.push(result);
    if (cs.combat_log.length > 50) cs.combat_log.shift();
  }

  /**
   * 检查是否需要开始战斗（由外部调用，如在 processTurn 中判断）
   */
  function shouldEnterCombat(gameState) {
    if (!gameState || !gameState.combat_stats) return false;
    return gameState.combat_stats.in_combat && !gameState.combat_stats.enemies;
  }

  /**
   * 是否有存活敌人
   */
  function hasAliveEnemies(gameState) {
    if (!gameState || !gameState.combat_stats) return false;
    var cs = gameState.combat_stats;
    if (!cs.in_combat || !cs.enemies) return false;
    return cs.enemies.some(function(e) { return e.hp > 0; });
  }

  return {
    spawnEnemy: spawnEnemy,
    initCombat: initCombat,
    endCombat: endCombat,
    playerAttack: playerAttack,
    playerCast: playerCast,
    processEnemyTurn: processEnemyTurn,
    advanceTurn: advanceTurn,
    completePlayerTurn: completePlayerTurn,
    getCombatReport: getCombatReport,
    buildCombatNarrativeHint: buildCombatNarrativeHint,
    shouldEnterCombat: shouldEnterCombat,
    hasAliveEnemies: hasAliveEnemies
  };
})();
