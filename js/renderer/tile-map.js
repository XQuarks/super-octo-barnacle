/**
 * CSS 像素风瓦片地图渲染器 — AetherNarrator CRPG
 * 纯 div + CSS 渲染，无图片依赖
 *
 * 依赖: js/map-data.js
 */
window.TileMap = (function() {
  'use strict';

  var _container = null;

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
   */
  function renderTile(tileId, legend, tileSize) {
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

    return '<div class="tile-cell" style="'
      + 'width:' + tileSize + ';height:' + tileSize + ';'
      + 'background:' + style.bg + ';'
      + 'border:' + style.border + ';'
      + innerStyle
      + '">'
      + symbolHtml
      + '</div>';
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
      return;
    }

    var parsed = MapDataV1.parse(mapData);
    var tileSize = parsed.tileSize || '48px';
    var legend = parsed.tileLegend;
    var grid = parsed.grid;
    var entities = parsed.entities;

    var html = '<div class="tile-map">';
    html += '<div class="tile-map-grid" style="'
      + 'grid-template-columns: repeat(' + parsed.width + ', ' + tileSize + ');'
      + 'grid-template-rows: repeat(' + parsed.height + ', ' + tileSize + ');'
      + '">';

    for (var y = 0; y < parsed.height; y++) {
      for (var x = 0; x < parsed.width; x++) {
        html += '<div class="tile-cell-wrapper" style="position:relative;">';
        html += renderTile(grid[y][x], legend, tileSize);

        // 查找该格的实体
        for (var i = 0; i < entities.length; i++) {
          if (entities[i].row === y && entities[i].col === x) {
            html += renderEntity(entities[i], legend, tileSize);
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
    if (_container) {
      _container.innerHTML = '';
      _container.classList.remove('show');
    }
  }

  /**
   * 更新地图（重渲染）
   */
  function update(mapData) {
    render(mapData);
  }

  /**
   * 地图瓦片点击处理
   */
  function onTileClick(row, col, parsed) {
    var tileId = MapDataV1.getTileAt(parsed, row, col);
    var legend = parsed.tileLegend;
    var tile = legend ? legend[tileId] : null;

    if (!tile) return;

    var entity = MapDataV1.getEntityAt(parsed, row, col);
    var gameState = window.gameState;

    // 实体交互提示
    if (entity && entity.id !== 'player') {
      if (entity.type === 'enemy' || entity.type === 'monster') {
        showMapTooltip('点击攻击 ' + (entity.name || '敌人'), row, col);
      } else if (entity.type === 'treasure' || entity.type === 'npc') {
        showMapTooltip('点击与 ' + (entity.name || entity.type) + ' 互动', row, col);
      }
    } else if (tile.blocked) {
      showMapTooltip('无法到达', row, col);
    } else {
      showMapTooltip('移动到 (' + col + ', ' + row + ')', row, col);
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
    TILE_STYLES: TILE_STYLES
  };
})();
