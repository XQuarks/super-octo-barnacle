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
    rest:     { label: '休息', icon: '\uD83D\uDCA4', needTarget: false, combatOnly: false },
    trade:    { label: '交易', icon: '\uD83D\uDCB0', needTarget: false, combatOnly: false },
    craft:    { label: '合成', icon: '\uD83D\uDD28', needTarget: false, combatOnly: false }
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
      // ★ ⑤ 已装备武器提供额外伤害加成
      if (typeof getWeaponDamageBonus === "function") damage += getWeaponDamageBonus(gameState);
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
   * 交易 / 购买：不掷骰，仅把「交易意图」交给 AI，由 AI 通过 inventory + currency 完成实际交易
   */
  function resolveTrade(gameState) {
    return { actionType: 'trade', rulesResult: {} };
  }

  /**
   * 合成 / 制作：不掷骰，仅把「制作意图」交给 AI，由 AI 在叙事中引导或直接通过合成工坊完成
   */
  function resolveCraft(gameState) {
    return { actionType: 'craft', rulesResult: {} };
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
        attrKey: attrKey,
        dc: dc,
        roll: check.roll,
        modifier: mod,
        total: check.total,
        success: check.success,
        nat1: check.nat1,
        nat20: check.nat20,
        degree: check.degree
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
      case 'talk':   return '尝试用话术说服/打动对方';
      case 'use_item': return '尝试用巧手使用/摆弄手头物品';
      case 'move':   return '尝试灵巧地移动、潜行或越过障碍';
      case 'rest':   return '原地稍作休息';
      case 'trade':  return '尝试与面前的商人或店铺交易，购买、出售或议价所需物品';
      case 'craft':  return '尝试动手制作或锻造某样东西，运用手头已有的材料';
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
      case 'skill_check':
        var ATTR_LABELS = { strength: 'STR', dexterity: 'DEX', constitution: 'CON', intelligence: 'INT', wisdom: 'WIS', charisma: 'CHA' };
        var attrLabel = ATTR_LABELS[r.attrKey] || r.attrKey || '属性';
        report = 'D20 ' + r.skillName + '检定：d20(' + r.roll + ') + ' + attrLabel + '调整值(' + r.modifier + ') = ' + r.total + '\n';
        report += '对抗 DC ' + r.dc + '... ' + (r.success ? '成功！' : '失败！') + '\n';
        if (r.nat20) report += '大成功！远超预期的效果！';
        else if (r.nat1) report += '大失败！弄巧成拙，可能引发尴尬或麻烦！';
        else if (r.success) report += '（检定等级：' + (r.degree >= 5 ? '卓越' : r.degree >= 0 ? '勉强达成' : '险过') + '）';
        else report += '（差 ' + (-r.degree) + ' 点未达成）';
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
      // ★ ⑤ 交易 / 合成：仅作意图提示，实际经济行为由 AI + inventory/currency 完成
      case 'trade':  result = resolveTrade(gameState); break;
      case 'craft':  result = resolveCraft(gameState); break;
      // ★ 非战斗技能检定（跑团核心）：交谈/物品/移动也掷骰，让"不确定结果的行动"成立
      case 'talk':     result = resolveSkillCheck(gameState, '说服', 'charisma', 13); break;
      case 'use_item': result = resolveSkillCheck(gameState, '巧手', 'dexterity', 13); break;
      case 'move':     result = resolveSkillCheck(gameState, '体操', 'dexterity', 12); break;
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

  function handleActionClick(actionType, targetId) {
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
        // ★ 地图点击敌人发起攻击时传入指定目标 id
        if (targetId) inputEl.setAttribute('data-action-target', targetId);
        if (typeof window.submitInput === 'function') {
          window.submitInput();
        }
      }
      return;
    }

    // ★ 双模式：纯叙事（AI 文字扮演冒险）不掷骰、不改数值，动作按钮仅作自由输入提示
    if (typeof isNarrativeMode === 'function' && isNarrativeMode()) {
      var narrativeInput = buildAutoInput(actionType, {}, gs);
      var nInput = document.getElementById('playerInput');
      if (nInput && narrativeInput) {
        nInput.value = narrativeInput;
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
    handleActionClick: handleActionClick,
    ACTION_TYPES: ACTION_TYPES
  };
})();
