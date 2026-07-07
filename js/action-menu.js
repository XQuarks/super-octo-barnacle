/**
 * 动作菜单 — AetherNarrator CRPG
 * 6 个动作按钮 + 规则引擎 + 自动输入文本生成
 *
 * 依赖: js/dice.js, js/combat-stats.js
 */
window.ActionMenu = (function() {
  'use strict';

  var _container = null;
  var _onAction = null;

  var ACTION_TYPES = {
    attack:   { label: '攻击', icon: '\u2694\uFE0F', needTarget: true,  combatOnly: true },
    cast:     { label: '施法', icon: '\u2728',    needTarget: true,  combatOnly: true },
    talk:     { label: '交谈', icon: '\uD83D\uDCAC', needTarget: false, combatOnly: false },
    use_item: { label: '物品', icon: '\uD83C\uDF92', needTarget: false, combatOnly: false },
    move:     { label: '移动', icon: '\uD83C\uDFC3', needTarget: false, combatOnly: false },
    rest:     { label: '休息', icon: '\uD83D\uDCA4', needTarget: false, combatOnly: false }
  };

  /**
   * 攻击：D20 检定 + 伤害计算
   */
  function resolveAttack(gameState) {
    var strMod = CombatStats.getMod(gameState, 'strength');
    var targetAc = 12;
    if (gameState.combat_stats && gameState.combat_stats.current_enemy) {
      targetAc = gameState.combat_stats.current_enemy.ac || 12;
    } else if (gameState.current_enemy && gameState.current_enemy.ac) {
      targetAc = gameState.current_enemy.ac;
    }
    var check = Dice.checkAgainst(strMod, targetAc);
    var damage = 0;
    if (check.success) {
      var dmgRoll = Dice.roll('1d8');
      damage = dmgRoll.total + strMod;
      damage = Math.max(1, damage);
    }
    return {
      actionType: 'attack',
      rulesResult: {
        roll: check.roll,
        modifier: strMod,
        total: check.total,
        targetAc: targetAc,
        success: check.success,
        nat1: check.nat1,
        nat20: check.nat20,
        damage: damage
      }
    };
  }

  /**
   * 施法：消耗 MP，INT 检定
   */
  function resolveCast(gameState) {
    var intMod = CombatStats.getMod(gameState, 'intelligence');
    var spellDc = 14;
    var check = Dice.checkAgainst(intMod, spellDc);
    var damage = 0;
    var mpCost = 2;
    if (check.success) {
      var dmgRoll = Dice.roll('2d6');
      damage = dmgRoll.total + intMod;
      damage = Math.max(1, damage);
    }
    return {
      actionType: 'cast',
      rulesResult: {
        roll: check.roll,
        modifier: intMod,
        total: check.total,
        spellDc: spellDc,
        success: check.success,
        nat1: check.nat1,
        nat20: check.nat20,
        damage: damage,
        mpCost: mpCost
      }
    };
  }

  /**
   * 休息：恢复少量 HP/MP
   */
  function resolveRest(gameState) {
    var healAmount = 3;
    var mpAmount = 2;
    return {
      actionType: 'rest',
      rulesResult: {
        healAmount: healAmount,
        mpAmount: mpAmount
      }
    };
  }

  /**
   * 技能检定（通用）
   */
  function resolveSkillCheck(gameState, skillName, attrKey, dc) {
    var mod = CombatStats.getMod(gameState, attrKey);
    var check = Dice.checkAgainst(mod, dc);
    return {
      actionType: 'skill_check',
      rulesResult: {
        skillName: skillName,
        dc: dc,
        roll: check.roll,
        modifier: mod,
        total: check.total,
        success: check.success,
        nat1: check.nat1,
        nat20: check.nat20
      }
    };
  }

  /**
   * 根据动作类型生成自动输入文本
   */
  function buildAutoInput(actionType, rulesResult, gameState) {
    switch (actionType) {
      case 'attack': return '用长剑攻击敌人';
      case 'cast':   return '施放魔法攻击敌人';
      case 'talk':   return '尝试与在场的人交谈';
      case 'use_item': return '使用背包中的物品';
      case 'move':   return '向新的方向探索前进';
      case 'rest':   return '原地稍作休息';
      default: return '';
    }
  }

  /**
   * 生成规则结果报告（附加到玩家输入）
   */
  function buildActionReport(actionResult) {
    var r = actionResult.rulesResult;
    var report = '';
    switch (actionResult.actionType) {
      case 'attack':
        report = 'D20 攻击检定：d20(' + r.roll + ') + STR调整值(' + r.modifier + ') = ' + r.total + '\n';
        report += '对抗敌方 AC ' + r.targetAc + '... ' + (r.success ? '命中！' : '未命中！') + '\n';
        if (r.success && r.damage) report += '伤害：' + r.damage + ' 点';
        if (r.nat20) report += '\n大成功！伤害加倍或附加特殊效果！';
        if (r.nat1) report += '\n大失败！可能出现严重后果！';
        break;
      case 'cast':
        report = 'D20 施法检定：d20(' + r.roll + ') + INT调整值(' + r.modifier + ') = ' + r.total + '\n';
        report += '对抗法术 DC ' + r.spellDc + '... ' + (r.success ? '成功！' : '失败！') + '\n';
        report += '消耗 MP: ' + r.mpCost;
        if (r.success && r.damage) report += '\n法术伤害：' + r.damage + ' 点';
        if (r.nat20) report += '\n大成功！法术效果翻倍！';
        if (r.nat1) report += '\n大失败！法术反噬！';
        break;
      case 'rest':
        report = '休息：恢复 HP ' + r.healAmount + ' 点，恢复 MP ' + r.mpAmount + ' 点';
        break;
      default:
        report = '';
    }
    return report;
  }

  /**
   * 派发动作：返回 { actionType, autoInput, actionReport }
   */
  function dispatch(actionType, gameState) {
    var result;
    switch (actionType) {
      case 'attack': result = resolveAttack(gameState); break;
      case 'cast':   result = resolveCast(gameState); break;
      case 'rest':   result = resolveRest(gameState); break;
      default: result = { actionType: actionType, rulesResult: {} };
    }

    var autoInput = buildAutoInput(actionType, result.rulesResult, gameState);
    var actionReport = buildActionReport(result);

    // 对于休息动作，直接应用效果
    if (actionType === 'rest') {
      CombatStats.applyHeal(gameState, result.rulesResult.healAmount);
      CombatStats.restoreMana(gameState, result.rulesResult.mpAmount);
    }

    result.autoInput = autoInput;
    result.actionReport = actionReport;
    return result;
  }

  /**
   * 设置动作菜单容器
   */
  function setContainer(el) {
    _container = el;
  }

  /**
   * 设置动作触发回调
   */
  function setOnAction(callback) {
    _onAction = callback;
  }

  /**
   * 渲染动作菜单
   */
  function render(gameState) {
    if (!_container) {
      // 自动查找或创建容器
      _container = document.getElementById('actionMenu');
      if (!_container) {
        _container = document.createElement('div');
        _container.id = 'actionMenu';
        _container.className = 'action-menu';
        var inputArea = document.querySelector('.game-input-area');
        if (inputArea) {
          inputArea.insertBefore(_container, inputArea.firstChild);
        }
      }
    }

    var inCombat = gameState && gameState.combat_stats && gameState.combat_stats.in_combat;

    var html = '';
    Object.keys(ACTION_TYPES).forEach(function(key) {
      var action = ACTION_TYPES[key];
      if (action.combatOnly && !inCombat) return;
      var cls = 'action-btn';
      if (action.combatOnly) cls += ' combat-only';
      html += '<button class="' + cls + '" data-action="' + key + '" title="' + action.label + '">';
      html += action.icon + ' ' + action.label;
      html += '</button>';
    });

    _container.innerHTML = html;

    // 绑定事件
    var buttons = _container.querySelectorAll('.action-btn');
    buttons.forEach(function(btn) {
      btn.addEventListener('click', function() {
        var actionType = this.getAttribute('data-action');
        handleActionClick(actionType);
      });
    });
  }

  function handleActionClick(actionType) {
    var gs = window.gameState;
    var inCombat = gs && gs.combat_stats && gs.combat_stats.in_combat;

    // 战斗模式下，不在此处做 D20 检定，留给 CombatEngine 处理
    if (inCombat && (actionType === 'attack' || actionType === 'cast')) {
      var actionLabels = { attack: '用长剑攻击敌人', cast: '施放魔法攻击敌人' };
      var inputEl = document.getElementById('playerInput');
      if (inputEl) {
        inputEl.value = actionLabels[actionType] || '';
        // 存储动作类型，processTurn 中 CombatEngine 会处理
        inputEl.setAttribute('data-action-type', actionType);
        if (typeof window.submitInput === 'function') {
          window.submitInput();
        }
      }
      return;
    }

    var result = dispatch(actionType, gs);

    // 填入输入框
    var inputEl2 = document.getElementById('playerInput');
    if (inputEl2) {
      inputEl2.value = result.autoInput;
      // 存储规则结果以便 processTurn 中使用
      inputEl2.setAttribute('data-action-result', JSON.stringify(result));
      // 清除旧的 data-action-type
      inputEl2.removeAttribute('data-action-type');
      // 自动提交
      if (typeof window.submitInput === 'function') {
        window.submitInput();
      }
    }
  }

  /**
   * 从输入框获取存储的动作结果
   */
  function getStoredResult(inputEl) {
    if (!inputEl) return null;
    var data = inputEl.getAttribute('data-action-result');
    if (!data) return null;
    inputEl.removeAttribute('data-action-result');
    try { return JSON.parse(data); } catch(e) { return null; }
  }

  function hide() {
    if (_container) _container.style.display = 'none';
  }

  function show() {
    if (_container) _container.style.display = '';
  }

  return {
    dispatch: dispatch,
    render: render,
    hide: hide,
    show: show,
    setContainer: setContainer,
    setOnAction: setOnAction,
    getStoredResult: getStoredResult,
    buildActionReport: buildActionReport,
    ACTION_TYPES: ACTION_TYPES
  };
})();
