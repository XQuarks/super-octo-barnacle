/**
 * 角色创建系统 — AetherNarrator CRPG
 * 种族选择 / 职业选择 / 属性投骰
 *
 * 依赖: js/dice.js
 */
window.CharacterCreator = (function() {
  'use strict';

  var _races = null;
  var _classes = null;
  var _loaded = false;

  var ATTR_NAMES = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];

  /**
   * 从 JSON 加载种族/职业数据
   */
  function loadData(data) {
    _races = data.races;
    _classes = data.classes;
    _loaded = true;
  }

  /**
   * 异步加载数据文件
   */
  function loadDataFile(url) {
    return fetch(url)
      .then(function(res) { return res.json(); })
      .then(function(data) {
        loadData(data);
        return data;
      });
  }

  function calcMod(value) {
    return Math.floor((value - 10) / 2);
  }

  /**
   * 属性投骰方法
   *   "4d6d1": 投 4 个 d6，去掉最低，求和（重复 6 次）
   *   "standard_array": [15, 14, 13, 12, 10, 8]
   *   "pointbuy": 27 点购点法
   */
  function rollAttributes(method) {
    method = method || 'standard_array';

    if (method === 'standard_array') {
      return [15, 14, 13, 12, 10, 8];
    }

    if (method === '4d6d1') {
      var results = [];
      for (var i = 0; i < 6; i++) {
        var rolls = [];
        for (var j = 0; j < 4; j++) {
          rolls.push(Math.floor(Math.random() * 6) + 1);
        }
        rolls.sort(function(a, b) { return a - b; });
        results.push(rolls[1] + rolls[2] + rolls[3]);
      }
      return results;
    }

    if (method === 'pointbuy') {
      return standardPointBuy();
    }

    return [10, 10, 10, 10, 10, 10];
  }

  /**
   * 27 点购点法
   */
  function standardPointBuy() {
    var scores = [8, 8, 8, 8, 8, 8];
    var points = 27;
    var costs = {
      8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9
    };

    var order = ATTR_NAMES.slice();
    for (var i = order.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = order[i];
      order[i] = order[j];
      order[j] = tmp;
    }

    // 每个属性先升到 10
    for (var k = 0; k < 6; k++) {
      scores[k] = 10;
      points -= 2;
    }
    // 剩下 15 点随机分配（模拟不完美的购点）
    var remaining = points;
    while (remaining > 0) {
      var idx = Math.floor(Math.random() * 6);
      if (scores[idx] < 15) {
        scores[idx]++;
        remaining--;
      }
    }

    return scores;
  }

  /**
   * 获取种族调整值
   */
  function getRaceModifiers(raceKey) {
    if (!_loaded) return {};
    var race = _races[raceKey];
    if (!race) return {};

    var mods = {};
    if (race.modifiers.all) {
      ATTR_NAMES.forEach(function(k) {
        mods[k] = race.modifiers.all;
      });
    } else {
      ATTR_NAMES.forEach(function(k) {
        mods[k] = race.modifiers[k] || 0;
      });
    }
    return mods;
  }

  /**
   * 获取职业基础数据
   */
  function getClassBase(classKey) {
    if (!_loaded) return { hp_base: 8, mp_base: 4, ac_base: 10, name: '冒险者' };
    return _classes[classKey] || { hp_base: 8, mp_base: 4, ac_base: 10, name: '冒险者' };
  }

  /**
   * 根据属性值数组构建完整的 combat_stats 对象
   * attrValues: 6 个属性值数组 [str, dex, con, int, wis, cha]
   * 顺序必须与 ATTR_NAMES 一致
   */
  function buildCombatStats(raceKey, classKey, attrValues) {
    var raceMods = getRaceModifiers(raceKey);
    var classBase = getClassBase(classKey);

    var attributes = {};
    ATTR_NAMES.forEach(function(k, i) {
      var val = (attrValues[i] || 10) + (raceMods[k] || 0);
      val = Math.max(3, Math.min(20, val));
      attributes[k] = {
        value: val,
        mod: calcMod(val),
        desc: ''
      };
    });

    var conMod = attributes.constitution.mod;
    var hp = classBase.hp_base + Math.max(1, conMod);

    var intMod = attributes.intelligence.mod;
    var wisMod = attributes.wisdom.mod;
    var mp = classBase.mp_base + Math.max(0, intMod) + Math.max(0, wisMod);

    var dexMod = attributes.dexterity.mod;
    var ac = (classBase.ac_base || 10) + Math.max(0, dexMod);

    return {
      max_hp: hp, hp: hp,
      max_mp: mp, mp: mp,
      ac: ac,
      level: 1, xp: 0, xp_to_next: 300,
      strength: attributes.strength,
      dexterity: attributes.dexterity,
      constitution: attributes.constitution,
      intelligence: attributes.intelligence,
      wisdom: attributes.wisdom,
      charisma: attributes.charisma,
      in_combat: false
    };
  }

  /**
   * 判断职业主属性
   */
  function getPrimaryAttr(classKey) {
    var cls = getClassBase(classKey);
    return cls.primary_attr || 'strength';
  }

  /**
   * 获取种族名称
   */
  function getRaceName(raceKey) {
    if (!_loaded) return raceKey;
    var race = _races[raceKey];
    return race ? race.name : raceKey;
  }

  /**
   * 获取职业名称
   */
  function getClassName(classKey) {
    if (!_loaded) return classKey;
    var cls = _classes[classKey];
    return cls ? cls.name : classKey;
  }

  return {
    loadData: loadData,
    loadDataFile: loadDataFile,
    calcMod: calcMod,
    rollAttributes: rollAttributes,
    getRaceModifiers: getRaceModifiers,
    getClassBase: getClassBase,
    buildCombatStats: buildCombatStats,
    getPrimaryAttr: getPrimaryAttr,
    getRaceName: getRaceName,
    getClassName: getClassName,
    ATTR_NAMES: ATTR_NAMES,
    isLoaded: function() { return _loaded; }
  };
})();
