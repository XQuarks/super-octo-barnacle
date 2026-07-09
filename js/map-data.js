/**
 * MapDataV1 协议 — AetherNarrator CRPG
 * 解析、校验、操作 AI 生成的地图数据
 */
window.MapDataV1 = (function() {
  'use strict';

  var VALID_MAP_TYPES = ['dungeon', 'town', 'battle', 'overworld'];

  /**
   * 校验协议格式
   */
  function validate(data) {
    var errors = [];

    if (!data) {
      errors.push('地图数据为空');
      return { valid: false, errors: errors };
    }

    if (data.protocol !== 'MapDataV1') {
      errors.push('缺少 protocol 字段或值不为 "MapDataV1"');
    }

    if (VALID_MAP_TYPES.indexOf(data.map_type) < 0) {
      errors.push('map_type 必须是 ' + VALID_MAP_TYPES.join('/') + ' 之一，当前值: ' + data.map_type);
    }

    if (typeof data.width !== 'number' || data.width < 3 || data.width > 20) {
      errors.push('width 必须是 3-20 的数字');
    }

    if (typeof data.height !== 'number' || data.height < 3 || data.height > 20) {
      errors.push('height 必须是 3-20 的数字');
    }

    if (!Array.isArray(data.grid)) {
      errors.push('grid 必须是二维数组');
    } else {
      if (data.grid.length !== data.height) {
        errors.push('grid 行数 (' + data.grid.length + ') 与 height (' + data.height + ') 不匹配');
      }
      for (var y = 0; y < data.grid.length; y++) {
        if (!Array.isArray(data.grid[y])) {
          errors.push('grid 第 ' + y + ' 行不是数组');
        } else if (data.grid[y].length !== data.width) {
          errors.push('grid 第 ' + y + ' 行列数 (' + data.grid[y].length + ') 与 width (' + data.width + ') 不匹配');
        }
      }
    }

    if (!data.tile_legend || typeof data.tile_legend !== 'object') {
      errors.push('tile_legend 必须是对象');
    }

    if (data.entities && !Array.isArray(data.entities)) {
      errors.push('entities 必须是数组');
    }

    if (data.entities) {
      data.entities.forEach(function(ent, i) {
        if (typeof ent.row !== 'number' || ent.row < 0 || ent.row >= data.height) {
          errors.push('entities[' + i + '] row 超出范围: ' + ent.row);
        }
        if (typeof ent.col !== 'number' || ent.col < 0 || ent.col >= data.width) {
          errors.push('entities[' + i + '] col 超出范围: ' + ent.col);
        }
      });
    }

    return { valid: errors.length === 0, errors: errors };
  }

  function parse(data) {
    return {
      protocol: data.protocol || 'MapDataV1',
      mapType: data.map_type,
      width: data.width,
      height: data.height,
      tileSize: data.tile_size || '48px',
      grid: data.grid || [],
      tileLegend: data.tile_legend || {},
      entities: (data.entities || []).map(function(e) {
        return { row: e.row, col: e.col, id: e.id || '', name: e.name || '', desc: e.desc || '', type: e.type || '' };
      }),
      description: data.description || '',
      // ★ 战争迷雾：已探索网格（二维布尔，持久化在 map 对象上）
      explored: data.explored || null,
      // ★ 战争迷雾开关：true=开启，false=关闭（缺省按世界设置，applyStateChanges 会补）
      fogOfWar: (typeof data.fog_of_war === 'boolean') ? data.fog_of_war : true,
      // ★ 命名地点节点：[{name,row,col}]，供叙事 current_location 反向回写时定位玩家坐标
      poi: (data.poi || []).map(function(p) {
        return { name: p.name || '', row: p.row, col: p.col };
      })
    };
  }

  /**
   * 创建一张全 false 的 explored 网格（height × width）
   */
  function createExploredGrid(width, height) {
    var g = [];
    for (var y = 0; y < height; y++) {
      var row = [];
      for (var x = 0; x < width; x++) row.push(false);
      g.push(row);
    }
    return g;
  }

  /**
   * 获取指定位置的 tile id
   */
  function getTileAt(map, row, col) {
    if (!map || !map.grid) return -1;
    if (row < 0 || row >= map.height || col < 0 || col >= map.width) return -1;
    var grid = Array.isArray(map.grid) ? map.grid : [];
    if (!grid[row]) return -1;
    return grid[row][col];
  }

  /**
   * 检查格子是否可通行（tile 的 blocked 不为 true）
   */
  function isWalkable(map, row, col) {
    var tileId = getTileAt(map, row, col);
    if (tileId < 0) return false;
    var legend = map.tileLegend || map.tile_legend || {};
    var tile = legend[tileId];
    if (!tile) return false;
    return !tile.blocked;
  }

  /**
   * 获取指定位置的实体
   */
  function getEntityAt(map, row, col) {
    if (!map || !map.entities) return null;
    for (var i = 0; i < map.entities.length; i++) {
      var ent = map.entities[i];
      if (ent.row === row && ent.col === col) return ent;
    }
    return null;
  }

  /**
   * 移动实体到新位置
   */
  function moveEntity(map, entityId, newRow, newCol) {
    if (!map || !map.entities) return false;
    for (var i = 0; i < map.entities.length; i++) {
      if (map.entities[i].id === entityId) {
        map.entities[i].row = newRow;
        map.entities[i].col = newCol;
        return true;
      }
    }
    return false;
  }

  /**
   * 移除实体
   */
  function removeEntity(map, entityId) {
    if (!map || !map.entities) return false;
    for (var i = 0; i < map.entities.length; i++) {
      if (map.entities[i].id === entityId) {
        map.entities.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  return {
    validate: validate,
    parse: parse,
    createExploredGrid: createExploredGrid,
    getTileAt: getTileAt,
    isWalkable: isWalkable,
    getEntityAt: getEntityAt,
    moveEntity: moveEntity,
    removeEntity: removeEntity,
    VALID_MAP_TYPES: VALID_MAP_TYPES
  };
})();
