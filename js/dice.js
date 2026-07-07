/**
 * D20 骰子系统 — AetherNarrator CRPG
 * 纯函数，无副作用，无 DOM 操作
 */
window.Dice = (function() {
  'use strict';

  function d20() {
    return Math.floor(Math.random() * 20) + 1;
  }

  function roll(diceNotation) {
    const match = diceNotation.match(/^(\d+)d(\d+)$/i);
    if (!match) throw new Error('Invalid dice notation: ' + diceNotation);

    const count = parseInt(match[1], 10);
    const sides = parseInt(match[2], 10);
    const rolls = [];

    for (let i = 0; i < count; i++) {
      rolls.push(Math.floor(Math.random() * sides) + 1);
    }

    const total = rolls.reduce((a, b) => a + b, 0);
    return { rolls, total, notation: diceNotation };
  }

  function check(modifier) {
    const roll = d20();
    const total = roll + (modifier || 0);
    return {
      roll: roll,
      modifier: modifier || 0,
      total: total,
      nat1: roll === 1,
      nat20: roll === 20,
      success: null
    };
  }

  function checkAgainst(modifier, dc) {
    const result = check(modifier);
    result.dc = dc;
    if (result.nat20) {
      result.success = true;
    } else if (result.nat1) {
      result.success = false;
    } else {
      result.success = result.total >= dc;
    }
    result.degree = result.total - dc;
    return result;
  }

  function advCheck(modifier) {
    const r1 = d20();
    const r2 = d20();
    const roll = Math.max(r1, r2);
    const total = roll + (modifier || 0);
    return {
      roll: roll,
      modifier: modifier || 0,
      total: total,
      nat1: roll === 1,
      nat20: roll === 20,
      advantage: true,
      rolls: [r1, r2],
      success: null
    };
  }

  function disCheck(modifier) {
    const r1 = d20();
    const r2 = d20();
    const roll = Math.min(r1, r2);
    const total = roll + (modifier || 0);
    return {
      roll: roll,
      modifier: modifier || 0,
      total: total,
      nat1: roll === 1,
      nat20: roll === 20,
      disadvantage: true,
      rolls: [r1, r2],
      success: null
    };
  }

  return {
    d20: d20,
    roll: roll,
    check: check,
    checkAgainst: checkAgainst,
    advCheck: advCheck,
    disCheck: disCheck
  };
})();
