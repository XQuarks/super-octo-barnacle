/**
 * CSS 像素风瓦片地图渲染器 — AetherNarrator CRPG
 * 纯 div + CSS 渲染，无图片依赖
 *
 * 依赖: js/map-data.js
 */
window.TileMap = (function() {
  'use strict';

  var _container = null;
  // ★ P5: 缓存上次渲染的地图摘要，避免每轮重建完全相同的 DOM
  var _lastMapDigest = null;

  /**
   * 瓦片样式定义（CSS inline style 片段）
   */
  var TILE_STYLES = {
    'bg-gray':     { bg: '#3a3630', border: '1px solid #4a4640', color: '#6a6660' },
    'bg-stone':    { bg: '#5a5548', border: '2px solid #4a4538', color: '#7a7568',
                     inner: 'box-shadow:inset 2px 2px 0 #6a6560,inset -2px -2px 0 #3a3528;' },
    'bg-door':     { bg: '#6a5040', border: '3px solid #8a6040', color: '#aa8060' },
    'bg-treasure': { bg: '#4a4030', border: '2px solid #c9a455', color: '#c9a455' },
    'bg-enemy':    { bg: '#4a3030', border: '2px solid #c56b5e', color: '#c56b5e' },
    'bg-player':   { bg: '#3a4a50', border: '2px solid #6ba4d4', color: '#6ba4d4' },
    'bg-water':    { bg: '#304a60', border: '2px solid #5090b0', color: '#70b0d0' },
    'bg-forest':   { bg: '#2a4a2a', border: '2px solid #3a6a3a', color: '#5a8a5a' },
    'bg-mountain': { bg: '#4a4a4a', border: '2px solid #6a6a6a', color: '#8a8a8a' },
    'bg-grass':    { bg: '#3a4a2a', border: '1px solid #4a5a3a', color: '#5a7a3a' },
    'bg-sand':     { bg: '#5a4a30', border: '1px solid #6a5a40', color: '#8a7a50' },
    'bg-building': { bg: '#5a4030', border: '2px solid #8a6040', color: '#aa8060' },
    'bg-road':     { bg: '#4a4038', border: '1px solid #5a5040', color: '#6a6050' },
    'bg-magic':    { bg: '#3a3050', border: '2px solid #6a50a0', color: '#9a80d0' },
    'bg-danger':   { bg: '#4a2020', border: '2px solid #a03030', color: '#d04040' },
    'bg-safe':     { bg: '#2a4a2a', border: '1px solid #4a7a4a', color: '#6aaa6a' }
  };

  /**
   * 渲染单个瓦片格
   * @param {boolean} dim 已探索但当前不可见时做暗淡处理
   */
  function renderTile(tileId, legend, tileSize, dim) {
    var tile = legend[tileId];
    if (!tile) {
      return '<div class="tile-cell" style="width:' + tileSize + ';height:' + tileSize
        + ';background:#2a2620;border:1px solid #3a3630;"></div>';
    }

    var cssClass = tile.css || 'bg-gray';
    var style = TILE_STYLES[cssClass] || TILE_STYLES['bg-gray'];

    var innerStyle = '';
    if (style.inner) innerStyle += style.inner;

    var symbolHtml = '';
    if (tile.symbol) {
      symbolHtml = '<span class="tile-symbol">' + escapeHtmlStr(tile.symbol) + '</span>';
    }

    var dimStyle = dim ? 'opacity:0.38;filter:grayscale(0.5);' : '';

    return '<div class="tile-cell" style="'
      + 'width:' + tileSize + ';height:' + tileSize + ';'
      + 'background:' + style.bg + ';'
      + 'border:' + style.border + ';'
      + innerStyle
      + dimStyle
      + '">'
      + symbolHtml
      + '</div>';
  }

  /**
   * 渲染未探索的迷雾格（纯黑/深紫，无符号、无实体）
   */
  function renderFogCell(tileSize) {
    return '<div class="tile-cell tile-fog" style="width:' + tileSize + ';height:' + tileSize
      + ';background:#15131c;border:1px solid #221d2e;box-shadow:inset 0 0 6px #000;"></div>';
  }

  /**
   * ★ 战争迷雾：计算当前可见网格。
   *  - 玩家所在 3×3（Chebyshev 半径 1）可见
   *  - 战斗中：存活的 _combat 敌人周围也可见（保证战场可见）
   * @returns {Array<Array<boolean>>}
   */
  function computeFogVisible(map) {
    var vis = MapDataV1.createExploredGrid(map.width, map.height);
    function reveal(r, c, rad) {
      for (var dy = -rad; dy <= rad; dy++) {
        for (var dx = -rad; dx <= rad; dx++) {
          var rr = r + dy, cc = c + dx;
          if (rr < 0 || rr >= map.height || cc < 0 || cc >= map.width) continue;
          vis[rr][cc] = true;
        }
      }
    }
    var ppos = (typeof findPlayerPos === 'function') ? findPlayerPos(map) : null;
    if (ppos) reveal(ppos.row, ppos.col, 1);

    var gs = window.gameState;
    if (gs && gs.combat_stats && gs.combat_stats.in_combat && gs.combat_stats.enemies && map.entities) {
      map.entities.forEach(function(e) {
        if (e.type !== 'enemy' && e.type !== 'boss' && e.type !== 'monster') return;
        if (!e._combat) return;
        var alive = gs.combat_stats.enemies.some(function(en) { return en.id === e.id && en.hp > 0; });
        if (alive) reveal(e.row, e.col, 1);
      });
    }
    return vis;
  }

  function escapeHtmlStr(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * 渲染实体标记
   */
  function renderEntity(entity, legend, tileSize) {
    var icons = {
      player: '@',
      monster: 'E',
      npc: 'N',
      boss: 'B',
      merchant: 'M',
      treasure: '$',
      enemy: 'E'
    };
    var icon = icons[entity.type] || '?';
    var color = '#fff';
    if (entity.type === 'player') color = '#6ba4d4';
    else if (entity.type === 'monster' || entity.type === 'boss' || entity.type === 'enemy') color = '#c56b5e';
    else if (entity.type === 'npc' || entity.type === 'merchant') color = '#c9a455';

    return '<span class="entity-label" style="color:' + color + ';">' + icon + '</span>';
  }

  /**
   * 渲染完整地图
   */
  function render(mapData) {
    if (!_container) {
      _container = document.getElementById('mapContainer');
    }
    if (!_container) return;

    var validation = MapDataV1.validate(mapData);
    if (!validation.valid) {
      console.warn('TileMap: 地图数据校验失败', validation.errors);
      _container.innerHTML = '';
      _container.classList.remove('show');
      _lastMapDigest = null;
      return;
    }

    // ★ P5: 增量渲染——先算摘要，跟上一次比对，相同则跳过整个 DOM 重建
    var parsed = MapDataV1.parse(mapData);
    var digest = _buildDigest(parsed);
    if (_lastMapDigest === digest) return;
    _lastMapDigest = digest;

    var tileSize = parsed.tileSize || '48px';
    var legend = parsed.tileLegend;
    var grid = parsed.grid;
    var entities = parsed.entities;

    // ★ 战争迷雾：仅当 fogOfWar 开启时计算可见/探索状态
    var fogOn = parsed.fogOfWar === true && !!parsed.explored;
    var visible = fogOn ? computeFogVisible(parsed) : null;

    var html = '<div class="tile-map">';
    html += '<div class="tile-map-grid" style="'
      + 'grid-template-columns: repeat(' + parsed.width + ', ' + tileSize + ');'
      + 'grid-template-rows: repeat(' + parsed.height + ', ' + tileSize + ');'
      + '">';

    for (var y = 0; y < parsed.height; y++) {
      for (var x = 0; x < parsed.width; x++) {
        html += '<div class="tile-cell-wrapper" style="position:relative;">';

        if (fogOn) {
          var isExplored = parsed.explored[y] && parsed.explored[y][x];
          var isVisible = visible[y] && visible[y][x];
          if (!isExplored) {
            html += renderFogCell(tileSize); // 未探索：纯迷雾
          } else if (!isVisible) {
            // 已探索但当前不可见：暗淡显示地形，隐藏动态实体
            html += renderTile(grid[y][x], legend, tileSize, true);
          } else {
            // 当前可见：正常渲染地形 + 实体
            html += renderTile(grid[y][x], legend, tileSize, false);
            for (var i = 0; i < entities.length; i++) {
              if (entities[i].row === y && entities[i].col === x) {
                html += renderEntity(entities[i], legend, tileSize);
              }
            }
          }
        } else {
          // 无迷雾：原样渲染
          html += renderTile(grid[y][x], legend, tileSize, false);
          for (var j = 0; j < entities.length; j++) {
            if (entities[j].row === y && entities[j].col === x) {
              html += renderEntity(entities[j], legend, tileSize);
            }
          }
        }

        html += '</div>';
      }
    }

    html += '</div>';

    // 图例
    html += '<div class="tile-map-legend">';
    var legendKeys = Object.keys(legend);
    var shown = 0;
    for (var k = 0; k < legendKeys.length && shown < 10; k++) {
      var key = legendKeys[k];
      var tile = legend[key];
      if (!tile) continue;
      var cssClass = tile.css || 'bg-gray';
      var style = TILE_STYLES[cssClass] || TILE_STYLES['bg-gray'];
      html += '<span><span class="legend-swatch" style="background:' + style.bg + ';border:' + style.border + ';"></span>'
        + escapeHtmlStr(tile.name || tile.symbol || key) + '</span>';
      shown++;
    }
    html += '</div>';

    // 描述文字
    if (parsed.description) {
      html += '<div class="tile-map-desc">' + escapeHtmlStr(parsed.description) + '</div>';
    }

    html += '</div>';

    _container.innerHTML = html;
    _container.classList.add('show');

    // ★ 添加点击交互
    var tiles = _container.querySelectorAll('.tile-cell-wrapper');
    tiles.forEach(function(wrapper, index) {
      var row = Math.floor(index / parsed.width);
      var col = index % parsed.width;
      wrapper.style.cursor = 'pointer';
      wrapper.addEventListener('click', function() {
        onTileClick(row, col, parsed);
      });
    });
  }

  /**
   * 清除地图
   */
  function clear() {
    _lastMapDigest = null;
    if (_container) {
      _container.innerHTML = '';
      _container.classList.remove('show');
    }
  }

  /**
   * ★ P5: 构建地图摘要——grid 二维数组 + 实体位置 + 迷雾探索状态的轻量摘要
   * 摘要相同的两次渲染跳过 DOM 重建，避免每轮无变化时重建全部瓦片
   */
  function _buildDigest(parsed) {
    var parts = [parsed.width, parsed.height, parsed.tileSize, parsed.map_type, parsed.description || ""];
    // grid 摘要
    for (var y = 0; y < parsed.height; y++) {
      for (var x = 0; x < parsed.width; x++) {
        parts.push(parsed.grid[y][x]);
      }
    }
    // 实体位置摘要
    if (parsed.entities) {
      parsed.entities.forEach(function(e) {
        parts.push(e.id + ":" + e.row + "," + e.col + ":" + (e._combat ? 1 : 0) + ":" + (e.hp || 0));
      });
    }
    // 迷雾摘要
    if (parsed.explored) {
      for (var ey = 0; ey < parsed.height; ey++) {
        for (var ex = 0; ex < parsed.width; ex++) {
          if (parsed.explored[ey] && parsed.explored[ey][ex]) parts.push("E" + ey + "x" + ex);
        }
      }
    }
    return parts.join("|");
  }

  /**
   * 更新地图（重渲染）
   */
  function update(mapData) {
    render(mapData);
  }

  /**
   * 地图瓦片点击处理
   * 接入：移动（BFS 寻路 + 位置/叙事同步）、NPC/宝箱交互、战斗模式点敌人攻击
   */
  function onTileClick(row, col, parsed) {
    var gameState = window.gameState;
    if (!gameState) return;
    var inCombat = !!(gameState.combat_stats && gameState.combat_stats.in_combat);
    var map = gameState.current_map;
    if (!map) return;

    var tileId = MapDataV1.getTileAt(parsed, row, col);
    var legend = parsed.tileLegend;
    var tile = legend ? legend[tileId] : null;
    var entity = MapDataV1.getEntityAt(parsed, row, col);

    // ---- 战斗模式：点敌人 = 攻击该敌人 ----
    if (inCombat) {
      if (entity && (entity.type === 'enemy' || entity.type === 'monster' || entity.type === 'boss')) {
        if (typeof window.ActionMenu !== 'undefined') {
          window.ActionMenu.handleActionClick('attack', entity.id);
        }
        return;
      }
      showMapTooltip('战斗中无法移动，点击敌人发起攻击', row, col);
      return;
    }

    // ---- 非战斗：与实体交互 ----
    if (entity && entity.type !== 'player') {
      if (entity.type === 'treasure') {
        showMapTooltip('调查：' + (entity.name || '宝箱'), row, col);
        if (typeof window.ActionMenu !== 'undefined') window.ActionMenu.handleActionClick('use_item');
        return;
      }
      if (entity.type === 'npc' || entity.type === 'merchant') {
        showMapTooltip('与 ' + (entity.name || 'NPC') + ' 交谈', row, col);
        if (typeof window.ActionMenu !== 'undefined') window.ActionMenu.handleActionClick('talk');
        return;
      }
    }

    // ---- 非战斗：移动 ----
    if (!tile || tile.blocked) { showMapTooltip('无法到达（障碍）', row, col); return; }
    if (entity && entity.type === 'player') { showMapTooltip('你在这里', row, col); return; }

    var ppos = (typeof findPlayerPos === 'function') ? findPlayerPos(parsed) : null;
    if (!ppos) { showMapTooltip('未找到玩家位置', row, col); return; }

    var path = (typeof findPath === 'function') ? findPath(parsed, ppos, { row: row, col: col }) : null;
    if (path === null) { showMapTooltip('无法到达（被阻挡）', row, col); return; }
    if (path.length === 0) { showMapTooltip('你已在此处', row, col); return; }
    if (path.length > 8) { showMapTooltip('太远了，一步步走过去', row, col); return; }

    // 执行移动：先改状态+重渲染，再触发"移动"动作（体力/体操检定 + 提交叙事）
    var dest = path[path.length - 1];
    if (typeof movePlayerOnMap === 'function') {
      movePlayerOnMap(gameState, dest.row, dest.col);
    }
    if (typeof window.ActionMenu !== 'undefined') {
      window.ActionMenu.handleActionClick('move');
    }
  }

  function showMapTooltip(msg, row, col) {
    // 简单提示：更新底部输入框
    var inputEl = document.getElementById('playerInput');
    if (inputEl && !window.gameState.combat_stats?.in_combat) {
      inputEl.placeholder = msg;
      setTimeout(function() {
        if (inputEl.placeholder === msg) inputEl.placeholder = '输入你想做的事...';
      }, 2000);
    }

    // 高亮被点击的瓦片
    var container = _container;
    if (container) {
      var wrappers = container.querySelectorAll('.tile-cell-wrapper');
      wrappers.forEach(function(w) { w.style.outline = ''; });
      var index = row * (container.querySelector('.tile-map-grid').style.gridTemplateColumns.match(/\d+/)?.[0] || 1) + col;
      var clicked = wrappers[index];
      if (clicked) {
        clicked.style.outline = '2px solid var(--primary)';
        setTimeout(function() { clicked.style.outline = ''; }, 600);
      }
    }
  }
  function setContainer(el) {
    _container = el;
  }

  return {
    render: render,
    clear: clear,
    update: update,
    setContainer: setContainer,
    onTileClick: onTileClick,
    computeFogVisible: computeFogVisible,
    TILE_STYLES: TILE_STYLES
  };
})();
