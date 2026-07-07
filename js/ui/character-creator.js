/**
 * 角色创建界面 — AetherNarrator CRPG
 * 种族选择 → 职业选择 → 属性投骰 → 确认汇总
 *
 * 依赖: js/dice.js, js/combat-stats.js, js/character.js, data/character_creation.json
 */
window.CharacterCreatorUI = (function() {
  'use strict';

  var _onConfirm = null;
  var _selectedRace = null;
  var _selectedClass = null;
  var _rolledAttrs = null;
  var _step = 1;

  function init() {
    return CharacterCreator.loadDataFile('./data/character_creation.json');
  }

  function show(callback) {
    _onConfirm = callback;
    _selectedRace = null;
    _selectedClass = null;
    _rolledAttrs = null;
    _step = 1;
    showModal('charCreateModal');
    renderStep();
  }

  function hide() {
    closeModal('charCreateModal');
  }

  function renderStep() {
    var step1 = document.getElementById('ccStep1');
    var step2 = document.getElementById('ccStep2');
    var step3 = document.getElementById('ccStep3');
    var step4 = document.getElementById('ccStep4');

    if (step1) step1.style.display = _step === 1 ? '' : 'none';
    if (step2) step2.style.display = _step === 2 ? '' : 'none';
    if (step3) step3.style.display = _step === 3 ? '' : 'none';
    if (step4) step4.style.display = _step === 4 ? '' : 'none';

    var dots = document.querySelectorAll('#ccProgressDots .cc-dot');
    dots.forEach(function(d, i) {
      d.className = 'cc-dot' + (i < _step ? ' done' : '') + (i === _step - 1 ? ' active' : '');
    });

    if (_step === 1) renderRaceSelection();
    if (_step === 2) renderClassSelection();
    if (_step === 3) renderAttrRoll();
    if (_step === 4) renderSummary();

    updateButtons();
  }

  // ===== Step 1: 种族选择 =====
  function renderRaceSelection() {
    if (!CharacterCreator.isLoaded()) {
      document.getElementById('ccRaceList').innerHTML = '<p class="cc-loading">加载种族数据...</p>';
      return;
    }
    var data = _races || {};
    var html = '';
    Object.keys(data).forEach(function(key) {
      var race = data[key];
      var mods = [];
      Object.keys(race.modifiers || {}).forEach(function(k) {
        var sign = race.modifiers[k] >= 0 ? '+' : '';
        mods.push(k.charAt(0).toUpperCase() + k.slice(1, 3) + ' ' + sign + race.modifiers[k]);
      });
      html += '<div class="cc-option race-option' + (_selectedRace === key ? ' selected' : '') + '" data-race="' + key + '">';
      html += '<div class="cc-option-name">' + race.name + '</div>';
      html += '<div class="cc-option-desc">' + race.desc + '</div>';
      html += '<div class="cc-option-mods">' + mods.join(' &middot; ') + '</div>';
      html += '</div>';
    });
    document.getElementById('ccRaceList').innerHTML = html;

    // 绑定点击
    var opts = document.querySelectorAll('.race-option');
    opts.forEach(function(o) {
      o.addEventListener('click', function() {
        _selectedRace = this.getAttribute('data-race');
        renderRaceSelection();
      });
    });
  }

  // ===== Step 2: 职业选择 =====
  function renderClassSelection() {
    if (!CharacterCreator.isLoaded()) return;
    var data = _classes || {};
    var html = '';
    Object.keys(data).forEach(function(key) {
      var cls = data[key];
      html += '<div class="cc-option class-option' + (_selectedClass === key ? ' selected' : '') + '" data-class="' + key + '">';
      html += '<div class="cc-option-name">' + cls.name + '</div>';
      html += '<div class="cc-option-desc">' + cls.desc + '</div>';
      html += '<div class="cc-option-mods">';
      html += 'HP基值 ' + cls.hp_base + ' &middot; MP基值 ' + cls.mp_base + ' &middot; AC基数 ' + cls.ac_base;
      html += '</div>';
      html += '<div class="cc-option-mods">主属性: ' + cls.primary_attr + ' &middot; ' + (cls.starting_skills || []).join(' / ') + '</div>';
      html += '</div>';
    });
    document.getElementById('ccClassList').innerHTML = html;

    var opts = document.querySelectorAll('.class-option');
    opts.forEach(function(o) {
      o.addEventListener('click', function() {
        _selectedClass = this.getAttribute('data-class');
        renderClassSelection();
      });
    });
  }

  // ===== Step 3: 属性投骰 =====
  function renderAttrRoll() {
    var labels = ['力量 STR', '敏捷 DEX', '体质 CON', '智力 INT', '感知 WIS', '魅力 CHA'];
    var raceMods = _selectedRace ? CharacterCreator.getRaceModifiers(_selectedRace) : {};

    if (!_rolledAttrs) {
      _rolledAttrs = CharacterCreator.rollAttributes('4d6d1');
    }

    var html = '<div class="cc-attr-grid">';

    CharacterCreator.ATTR_NAMES.forEach(function(k, i) {
      var base = _rolledAttrs[i];
      var raceBonus = raceMods[k] || 0;
      var final = Math.max(3, Math.min(20, base + raceBonus));
      var mod = Math.floor((final - 10) / 2);
      var sign = mod >= 0 ? '+' : '';

      html += '<div class="cc-attr-cell">';
      html += '<div class="cc-attr-label">' + labels[i] + '</div>';
      html += '<div class="cc-attr-value">' + final + ' <span class="cc-attr-mod">(' + sign + mod + ')</span></div>';
      if (raceBonus !== 0) {
        var bonusSign = raceBonus > 0 ? '+' : '';
        html += '<div class="cc-attr-bonus">种族 ' + bonusSign + raceBonus + '</div>';
      }
      html += '<div class="cc-attr-base">基础 ' + base + '</div>';
      html += '</div>';
    });

    html += '</div>';
    html += '<div class="cc-attr-actions">';
    html += '<button class="cc-btn cc-btn-secondary" onclick="CharacterCreatorUI.reroll()">重新投骰 (4d6取最高3)</button>';
    html += '</div>';

    document.getElementById('ccAttrArea').innerHTML = html;
  }

  function reroll() {
    _rolledAttrs = null;
    renderAttrRoll();
  }

  // ===== Step 4: 确认汇总 =====
  function renderSummary() {
    var raceName = CharacterCreator.getRaceName(_selectedRace);
    var className = CharacterCreator.getClassName(_selectedClass);
    var raceMods = CharacterCreator.getRaceModifiers(_selectedRace);
    var combatStats = CharacterCreator.buildCombatStats(_selectedRace, _selectedClass, _rolledAttrs);

    var labels = { strength: '力量', dexterity: '敏捷', constitution: '体质',
                   intelligence: '智力', wisdom: '感知', charisma: '魅力' };

    var html = '<div class="cc-summary">';

    html += '<div class="cc-summary-row"><span class="cc-sum-label">种族</span><span>' + raceName + '</span></div>';
    html += '<div class="cc-summary-row"><span class="cc-sum-label">职业</span><span>' + className + '</span></div>';
    html += '<div class="cc-summary-row"><span class="cc-sum-label">等级</span><span>Lv.1</span></div>';
    html += '<div class="cc-summary-sep"></div>';

    Object.keys(labels).forEach(function(k) {
      var attr = combatStats[k];
      var sign = attr.mod >= 0 ? '+' : '';
      html += '<div class="cc-summary-row"><span class="cc-sum-label">' + labels[k] + '</span><span>' + attr.value + ' (' + sign + attr.mod + ')</span></div>';
    });

    html += '<div class="cc-summary-sep"></div>';
    html += '<div class="cc-summary-row"><span class="cc-sum-label">生命值 HP</span><span style="color:var(--danger)">' + combatStats.hp + '</span></div>';
    html += '<div class="cc-summary-row"><span class="cc-sum-label">法力值 MP</span><span style="color:#6BA4D4">' + combatStats.mp + '</span></div>';
    html += '<div class="cc-summary-row"><span class="cc-sum-label">护甲 AC</span><span>' + combatStats.ac + '</span></div>';

    html += '</div>';

    document.getElementById('ccSummaryArea').innerHTML = html;

    // 保存结果
    window._ccResult = {
      race: _selectedRace,
      class: _selectedClass,
      attrs: _rolledAttrs,
      combatStats: combatStats
    };
  }

  // ===== 导航 =====
  function nextStep() {
    if (_step === 1 && !_selectedRace) { showToast('请选择一个种族', 'warn'); return; }
    if (_step === 2 && !_selectedClass) { showToast('请选择一个职业', 'warn'); return; }
    if (_step === 3 && !_rolledAttrs) { showToast('请先投骰属性', 'warn'); return; }
    if (_step < 4) {
      _step++;
      renderStep();
      var top = document.getElementById('ccSteps');
      if (top) top.scrollIntoView({ behavior: 'smooth' });
    } else {
      // 确认创建
      if (_onConfirm) _onConfirm(window._ccResult);
      hide();
    }
  }

  function prevStep() {
    if (_step > 1) {
      _step--;
      renderStep();
      var top = document.getElementById('ccSteps');
      if (top) top.scrollIntoView({ behavior: 'smooth' });
    }
  }

  function updateButtons() {
    var prevBtn = document.getElementById('ccPrevBtn');
    var nextBtn = document.getElementById('ccNextBtn');
    if (prevBtn) prevBtn.style.display = _step > 1 ? '' : 'none';
    if (nextBtn) nextBtn.textContent = _step === 4 ? '确认创建' : '下一步';
  }

  return {
    init: init,
    show: show,
    hide: hide,
    reroll: reroll,
    nextStep: nextStep,
    prevStep: prevStep,
    getResult: function() { return window._ccResult; }
  };
})();
