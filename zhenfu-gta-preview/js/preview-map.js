(() => {
  const ORIGIN = { longitude: 121.3146923, latitude: 24.9979870 };
  const RADIUS_M = 200;
  // Nearby NLSC building meshes meet the ground at about 89.85 m ellipsoidal height.
  const GROUND_M = 89.85;
  const TILESET_URL = 'https://3dtiles.nlsc.gov.tw/building/tiles3d/37/tileset.json';
  const ROAD_TILESET_URL = 'https://3dtiles.nlsc.gov.tw/road/tiles3d/7/tileset.json';
  const M_LAT = 110540;
  const M_LON = 111320 * Math.cos(ORIGIN.latitude * Math.PI / 180);
  const FLOOR_PX = 72;
  const BAY_PX = 96;
  const KIND_LABEL = {
    shophouse: '店屋',
    apt: '公寓',
    mid: '中層',
    temple: '廟宇',
    civic: '公共'
  };

  const status = document.getElementById('status');
  const statusText = document.getElementById('statusText');
  const procCountEl = document.getElementById('procCount');
  const tileStateEl = document.getElementById('tileState');
  const pickLine = document.getElementById('pickLine');

  const report = {
    mode: 'both',
    tiles: 'loading',
    roads: 'loading',
    procedural: 'loading',
    source: '',
    count: 0,
    leveled: 0
  };

  const setStatus = (state, text) => {
    status.dataset.state = state;
    statusText.textContent = text;
  };

  const renderStatus = () => {
    procCountEl.textContent = report.count ? String(report.count) + ' 棟' : '—';
    tileStateEl.textContent = report.tiles === 'ready' ? '已連線' : (report.tiles === 'error' ? '未連線' : '連線中');
    if (report.procedural === 'error' && report.tiles === 'error') {
      setStatus('error', '官方 3D 建物與程序化輪廓都暫時無法載入。底圖仍可移動，請稍後重新整理。');
      return;
    }
    if (report.procedural === 'loading' || report.tiles === 'loading') {
      setStatus('loading', '正在連線官方 3D 建物，並鋪設程序化招牌樓…');
      return;
    }
    const bits = [];
    if (report.tiles === 'ready') bits.push('官方 3D 建物已連線');
    else bits.push('官方 3D 建物暫時無法載入');
    if (report.procedural === 'ready') {
      const src = report.source === 'overpass' ? 'Overpass 即時輪廓' : '內建 OSM 輪廓';
      bits.push('程序化招牌樓 ' + report.count + ' 棟（' + src + (report.leveled ? '，' + report.leveled + ' 棟有樓層' : '') + '）');
    } else bits.push('程序化輪廓暫時無法載入');
    setStatus(report.tiles === 'error' && report.procedural !== 'ready' ? 'error' : 'ready', bits.join('。') + '。灰盒立面，不是實景街廓。');
  };

  if (!window.Cesium) {
    setStatus('error', '地圖元件無法載入，請重新整理頁面。');
    return;
  }

  const Cesium = window.Cesium;
  let viewer;
  let buildingTileset = null;
  let roadTileset = null;
  let rangeEntity = null;
  let ringLine = null;
  let groundDisc = null;
  let procPrimitives = [];
  let nameEntities = [];
  let mode = 'both';
  const facadeCache = new Map();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const frameCamera = (headingDeg, distance, pitchDeg, lookAboveGround, lon = ORIGIN.longitude, lat = ORIGIN.latitude) => {
    const pitch = pitchDeg * Math.PI / 180;
    const lookH = GROUND_M + lookAboveGround;
    const camH = lookH + distance * Math.tan(Math.abs(pitch));
    const back = (headingDeg + 180) * Math.PI / 180;
    const north = Math.cos(back) * distance;
    const east = Math.sin(back) * distance;
    return {
      destination: Cesium.Cartesian3.fromDegrees(
        lon + east / M_LON,
        lat + north / M_LAT,
        camH
      ),
      orientation: {
        heading: Cesium.Math.toRadians(headingDeg),
        pitch: Cesium.Math.toRadians(pitchDeg),
        roll: 0
      }
    };
  };

  const streetView = frameCamera(55, 168, -32, 14);
  const overviewView = frameCamera(35, 340, -50, 18);
  let facadeView = frameCamera(48, 36, -18, 6);

  const fly = (view) => viewer.camera.flyTo({
    destination: view.destination,
    orientation: view.orientation,
    duration: reducedMotion ? 0 : 0.85
  });

  const hashId = (id) => {
    let h = 2166136261;
    const s = String(id);
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };

  const num = (value) => {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : NaN;
  };

  const classify = (tags, seed) => {
    const building = String(tags.building || '').toLowerCase();
    const amenity = String(tags.amenity || '').toLowerCase();
    const levels = num(tags['building:levels']);
    if (building === 'temple' || building === 'religious' || amenity === 'place_of_worship') return 'temple';
    if (building === 'government' || building === 'civic' || building === 'public' || amenity === 'police' || amenity === 'community_centre') return 'civic';
    if (building === 'commercial' || building === 'retail' || amenity === 'marketplace') return levels >= 7 ? 'mid' : 'shophouse';
    if (building === 'apartments' || building === 'residential') return levels >= 8 ? 'mid' : 'apt';
    if (levels >= 8) return 'mid';
    if (levels >= 5) return 'apt';
    if (seed % 5 === 0) return 'apt';
    return 'shophouse';
  };

  const measure = (tags, kind, seed) => {
    const heightTag = num(tags.height);
    if (heightTag > 2 && heightTag < 80) {
      return { height: heightTag, floors: Math.max(1, Math.min(14, Math.round(heightTag / 3.15))), source: 'height' };
    }
    const levels = num(tags['building:levels']);
    if (levels >= 1 && levels <= 20) {
      const floors = Math.max(1, Math.min(14, Math.round(levels)));
      return { height: floors * 3.15, floors, source: 'levels' };
    }
    const table = {
      shophouse: [3, 4, 3, 2],
      apt: [5, 5, 6, 4],
      mid: [8, 9, 8],
      temple: [2, 1],
      civic: [3, 2, 3]
    };
    const choices = table[kind];
    const floors = choices[seed % choices.length];
    return { height: floors * 3.15, floors, source: 'recipe' };
  };

  const paintWindow = (ctx, x, y, w, h, lit) => {
    ctx.fillStyle = '#2c3134';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = lit ? '#f0d7a4' : '#7ea0b3';
    ctx.fillRect(x + 3, y + 3, w - 6, h - 6);
    ctx.strokeStyle = 'rgba(28, 34, 38, 0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + w / 2, y + 3);
    ctx.lineTo(x + w / 2, y + h - 3);
    ctx.moveTo(x + 3, y + h / 2);
    ctx.lineTo(x + w - 3, y + h / 2);
    ctx.stroke();
  };

  const paintSign = (ctx, x, y, w, h, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(255, 248, 230, 0.92)';
    const blocks = 3;
    const gap = 4;
    const bw = (w - gap * (blocks + 1)) / blocks;
    for (let i = 0; i < blocks; i += 1) {
      ctx.fillRect(x + gap + i * (bw + gap), y + 4, bw, h - 8);
    }
  };

  const facadeCanvas = (kind, floors, variant) => {
    const key = kind + ':' + floors + ':' + variant;
    const cached = facadeCache.get(key);
    if (cached) return cached;
    const canvas = document.createElement('canvas');
    canvas.width = BAY_PX;
    canvas.height = FLOOR_PX * floors;
    const ctx = canvas.getContext('2d', { alpha: false });
    const walls = {
      shophouse: ['#efe2cf', '#e7d3b4', '#f4e7d6'],
      apt: ['#d9d3c8', '#cfc6b8', '#e4ddd2'],
      mid: ['#c5cdd4', '#b7c3cc', '#d5dde3'],
      temple: ['#f3e6cf', '#ead6b4', '#f7edd9'],
      civic: ['#e7e2d6', '#ddd6c8', '#efeae0']
    };
    const signs = ['#c44536', '#d89a1a', '#2f6f4e'];
    ctx.fillStyle = walls[kind][variant % 3];
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(40, 36, 28, 0.08)';
    ctx.fillRect(0, 0, 5, canvas.height);
    ctx.fillRect(canvas.width - 5, 0, 5, canvas.height);

    for (let floor = 0; floor < floors; floor += 1) {
      const y = canvas.height - (floor + 1) * FLOOR_PX;
      const lit = (floor + variant) % 3 === 0;
      if (kind === 'shophouse' && floor === 0) {
        paintSign(ctx, 8, y + 6, BAY_PX - 16, 16, signs[variant % 3]);
        ctx.fillStyle = '#5c4a3a';
        ctx.fillRect(0, y + 26, 10, FLOOR_PX - 26);
        ctx.fillRect(BAY_PX - 10, y + 26, 10, FLOOR_PX - 26);
        ctx.fillStyle = '#6e8c9e';
        ctx.fillRect(14, y + 30, BAY_PX - 28, FLOOR_PX - 38);
        ctx.fillStyle = '#3e2c24';
        ctx.fillRect(18, y + 40, 16, FLOOR_PX - 42);
        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        ctx.fillRect(16, y + 32, 6, FLOOR_PX - 44);
      } else if (kind === 'temple' && floor === 0) {
        ctx.fillStyle = '#8c2f2f';
        ctx.fillRect(6, y + 8, 12, FLOOR_PX - 10);
        ctx.fillRect(BAY_PX - 18, y + 8, 12, FLOOR_PX - 10);
        ctx.fillStyle = '#6b2a22';
        ctx.fillRect(34, y + 28, 28, FLOOR_PX - 30);
        ctx.fillStyle = '#e6c56a';
        ctx.fillRect(44, y + 40, 8, 12);
      } else if (kind === 'mid' && floor === 0) {
        ctx.fillStyle = '#8d9394';
        ctx.fillRect(0, y + FLOOR_PX - 10, BAY_PX, 10);
        paintSign(ctx, 10, y + 8, BAY_PX - 20, 12, '#3d4c55');
        ctx.fillStyle = '#8eacbc';
        ctx.fillRect(8, y + 26, BAY_PX - 16, FLOOR_PX - 40);
      } else if (kind === 'civic' && floor === 0) {
        ctx.fillStyle = '#3e5c49';
        ctx.fillRect(8, y + 8, BAY_PX - 16, 10);
        ctx.fillStyle = '#6d8494';
        ctx.fillRect(14, y + 26, BAY_PX - 28, FLOOR_PX - 34);
        ctx.fillStyle = '#3f4f46';
        ctx.fillRect(40, y + 36, 18, FLOOR_PX - 38);
      } else if (kind === 'mid') {
        ctx.fillStyle = '#9aa8b0';
        ctx.fillRect(6, y + 8, BAY_PX - 12, 14);
        ctx.fillStyle = lit ? '#d5e4ea' : '#6f92a6';
        ctx.fillRect(6, y + 22, BAY_PX - 12, 36);
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(8, y + 24, 10, 30);
      } else if (kind === 'temple') {
        ctx.fillStyle = '#8c2f2f';
        ctx.fillRect(8, y + 6, 8, FLOOR_PX - 12);
        ctx.fillRect(BAY_PX - 16, y + 6, 8, FLOOR_PX - 12);
        paintWindow(ctx, 30, y + 16, 36, 40, false);
      } else {
        paintWindow(ctx, 22, y + 12, 52, 40, lit && kind === 'apt');
        if (kind === 'apt') {
          ctx.fillStyle = '#9aa3a8';
          ctx.fillRect(78, y + 22, 10, 16);
          ctx.fillStyle = '#b7aea2';
          ctx.fillRect(16, y + 54, 64, 4);
          ctx.fillStyle = '#8d8478';
          for (let rail = 20; rail < 78; rail += 8) ctx.fillRect(rail, y + 48, 2, 8);
        }
      }
    }

    if (kind === 'temple') {
      ctx.fillStyle = '#8d3b32';
      ctx.fillRect(0, 0, canvas.width, 8);
    } else {
      ctx.fillStyle = 'rgba(40, 36, 28, 0.18)';
      ctx.fillRect(0, 0, canvas.width, 4);
    }

    facadeCache.set(key, canvas);
    return canvas;
  };

  const toLocal = (lon, lat) => ({
    x: (lon - ORIGIN.longitude) * M_LON,
    y: (lat - ORIGIN.latitude) * M_LAT
  });

  const toLonLat = (x, y) => [
    ORIGIN.longitude + x / M_LON,
    ORIGIN.latitude + y / M_LAT
  ];

  const cleanRing = (ring) => {
    const pts = [];
    ring.forEach((pair) => {
      const lon = pair[0];
      const lat = pair[1];
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
      const prev = pts[pts.length - 1];
      if (prev && Math.hypot(prev.x - (lon - ORIGIN.longitude) * M_LON, prev.y - (lat - ORIGIN.latitude) * M_LAT) < 0.35) return;
      pts.push(toLocal(lon, lat));
    });
    if (pts.length > 2 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 0.35) pts.pop();
    return pts;
  };

  const ringStats = (pts) => {
    let area = 0;
    let perimeter = 0;
    for (let i = 0; i < pts.length; i += 1) {
      const j = (i + 1) % pts.length;
      area += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
      perimeter += Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y);
    }
    const cx = pts.reduce((sum, p) => sum + p.x, 0) / pts.length;
    const cy = pts.reduce((sum, p) => sum + p.y, 0) / pts.length;
    return { area: Math.abs(area) / 2, signed: area / 2, perimeter, cx, cy };
  };

  const normalize = (data) => {
    if (data && Array.isArray(data.buildings)) {
      return data.buildings.map((b) => ({ id: b.id, tags: b.tags || {}, ring: b.ring || [] }));
    }
    if (data && Array.isArray(data.elements)) {
      return data.elements
        .filter((el) => el.type === 'way' && Array.isArray(el.geometry))
        .map((el) => ({
          id: el.id,
          tags: el.tags || {},
          ring: el.geometry.map((p) => [p.lon, p.lat])
        }));
    }
    return [];
  };

  const clearProcedural = () => {
    procPrimitives.forEach((primitive) => viewer.scene.primitives.remove(primitive));
    nameEntities.forEach((entity) => viewer.entities.remove(entity));
    procPrimitives = [];
    nameEntities = [];
  };

  const heightLabel = (spec) => {
    if (spec.source === 'height') return 'OSM 高度';
    if (spec.source === 'levels') return 'OSM ' + spec.floors + ' 層';
    return '示意 ' + spec.floors + ' 層';
  };

  const buildProcedural = (records, sourceName) => {
    clearProcedural();
    const wallGroups = new Map();
    const roofInstances = [];
    let count = 0;
    let leveled = 0;
    let facadeTarget = null;
    const mix = { shophouse: 0, apt: 0, mid: 0, temple: 0, civic: 0 };

    records.forEach((record) => {
      let pts = cleanRing(record.ring);
      if (pts.length < 3) return;
      const stats = ringStats(pts);
      if (stats.area < 25 || stats.perimeter < 12) return;
      const near = Math.hypot(stats.cx, stats.cy) <= RADIUS_M + 8
        || pts.some((p) => Math.hypot(p.x, p.y) <= RADIUS_M);
      if (!near) return;
      if (stats.signed < 0) pts.reverse();

      const seed = hashId(record.id);
      const kind = classify(record.tags || {}, seed);
      const spec = measure(record.tags || {}, kind, seed);
      if (spec.source !== 'recipe') leveled += 1;
      const variant = seed % 3;
      const bayWidth = kind === 'apt' ? 3.6 : (kind === 'mid' ? 4.6 : (kind === 'temple' ? 5 : 4.1));
      const bays = Math.max(2, Math.min(48, Math.round(stats.perimeter / bayWidth)));
      const outset = 0.55;
      pts = pts.map((p) => {
        const dx = p.x - stats.cx;
        const dy = p.y - stats.cy;
        const len = Math.hypot(dx, dy) || 1;
        return { x: p.x + (dx / len) * outset, y: p.y + (dy / len) * outset };
      });

      const base = GROUND_M + 0.2;
      const roof = base + spec.height;
      const positions = pts.map((p) => {
        const ll = toLonLat(p.x, p.y);
        return Cesium.Cartesian3.fromDegrees(ll[0], ll[1]);
      });
      const closed = positions.concat([positions[0]]);
      const wallGeometry = Cesium.WallGeometry.createGeometry(new Cesium.WallGeometry({
        positions: closed,
        minimumHeights: closed.map(() => base),
        maximumHeights: closed.map(() => roof + 0.3),
        vertexFormat: Cesium.MaterialAppearance.VERTEX_FORMAT
      }));
      if (!wallGeometry) return;
      // Cesium's wall s is per corner, not per metre. Rewrite it so one facade bay is one texture repeat.
      const posValues = wallGeometry.attributes.position.values;
      const stValues = wallGeometry.attributes.st.values;
      const pairs = stValues.length / 4;
      const along = [0];
      let travelled = 0;
      for (let i = 1; i < pairs; i += 1) {
        const ax = posValues[(i - 1) * 6];
        const ay = posValues[(i - 1) * 6 + 1];
        const az = posValues[(i - 1) * 6 + 2];
        const bx = posValues[i * 6];
        const by = posValues[i * 6 + 1];
        const bz = posValues[i * 6 + 2];
        travelled += Math.hypot(bx - ax, by - ay, bz - az);
        along.push(travelled);
      }
      const metresPerBay = (travelled || stats.perimeter) / bays;
      for (let i = 0; i < pairs; i += 1) {
        const s = along[i] / metresPerBay;
        stValues[i * 4] = s;
        stValues[i * 4 + 2] = s;
      }

      const meta = {
        osmId: record.id,
        kind,
        kindLabel: KIND_LABEL[kind],
        floors: spec.floors,
        height: spec.height,
        source: spec.source,
        name: record.tags && record.tags.name ? String(record.tags.name) : ''
      };
      const groupKey = kind + ':' + spec.floors + ':' + variant;
      if (!wallGroups.has(groupKey)) {
        wallGroups.set(groupKey, {
          canvas: facadeCanvas(kind, spec.floors, variant),
          instances: []
        });
      }
      wallGroups.get(groupKey).instances.push(new Cesium.GeometryInstance({
        geometry: wallGeometry,
        id: meta
      }));

      const roofGeometry = new Cesium.PolygonGeometry({
        polygonHierarchy: new Cesium.PolygonHierarchy(positions),
        height: roof,
        vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT
      });
      const roofColors = {
        shophouse: '#8d7a68',
        apt: '#7e868c',
        mid: '#6e7c86',
        temple: '#8d3b32',
        civic: '#6e7a70'
      };
      roofInstances.push(new Cesium.GeometryInstance({
        geometry: roofGeometry,
        id: meta,
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            Cesium.Color.fromCssColorString(roofColors[kind])
          )
        }
      }));

      if (meta.name) {
        const ll = toLonLat(stats.cx, stats.cy);
        nameEntities.push(viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(ll[0], ll[1], roof + 2.4),
          label: {
            text: meta.name,
            font: '600 14px "PingFang TC","Noto Sans TC",sans-serif',
            fillColor: Cesium.Color.fromCssColorString('#243126'),
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString('#f7f3e8').withAlpha(0.9),
            backgroundPadding: new Cesium.Cartesian2(6, 4),
            style: Cesium.LabelStyle.FILL,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 520)
          }
        }));
      }

      const dist = Math.hypot(stats.cx, stats.cy);
      if (!facadeTarget || dist < facadeTarget.d) {
        const ll = toLonLat(stats.cx, stats.cy);
        facadeTarget = { d: dist, lon: ll[0], lat: ll[1], height: spec.height, name: meta.name, kind };
      }
      count += 1;
      mix[kind] += 1;
    });

    if (facadeTarget) {
      const look = Math.max(3.2, Math.min(facadeTarget.height * 0.45, 11));
      facadeView = frameCamera(24, 28, -18, look, facadeTarget.lon, facadeTarget.lat);
    }

    wallGroups.forEach((group) => {
      const primitive = viewer.scene.primitives.add(new Cesium.Primitive({
        geometryInstances: group.instances,
        appearance: new Cesium.MaterialAppearance({
          material: Cesium.Material.fromType('Image', {
            image: group.canvas,
            repeat: new Cesium.Cartesian2(1, 1)
          }),
          faceForward: true,
          flat: true,
          translucent: false,
          closed: false
        }),
        asynchronous: true,
        releaseGeometryInstances: false
      }));
      procPrimitives.push(primitive);
    });

    if (roofInstances.length) {
      procPrimitives.push(viewer.scene.primitives.add(new Cesium.Primitive({
        geometryInstances: roofInstances,
        appearance: new Cesium.PerInstanceColorAppearance({
          flat: true,
          translucent: false,
          closed: false
        }),
        asynchronous: true,
        releaseGeometryInstances: false
      })));
    }

    report.count = count;
    report.leveled = leveled;
    report.source = sourceName;
    report.procedural = count ? 'ready' : 'error';
    report.mix = mix;
    applyMode(mode);
    renderStatus();
    window.__zhenfuPreview.chunks = wallGroups.size;
    window.__zhenfuPreview.facadeTarget = facadeTarget;
  };

  const applyMode = (next) => {
    mode = next;
    const showProc = mode !== 'tiles';
    const showBuildings = mode !== 'proc';
    if (buildingTileset) {
      buildingTileset.show = showBuildings;
      buildingTileset.style = new Cesium.Cesium3DTileStyle({
        color: mode === 'both' ? "color('white', 0.45)" : "color('white', 1.0)"
      });
    }
    if (roadTileset) roadTileset.show = true;
    procPrimitives.forEach((primitive) => { primitive.show = showProc; });
    nameEntities.forEach((entity) => { entity.show = showProc; });
    if (groundDisc) groundDisc.show = true;
    document.querySelectorAll('[data-mode]').forEach((button) => {
      button.setAttribute('aria-pressed', button.dataset.mode === mode ? 'true' : 'false');
    });
    window.__zhenfuPreview.mode = mode;
  };

  const idsOf = (records) => records.map((r) => r.id).sort((a, b) => a - b).join(',');

  const circlePositions = (radius, height) => {
    const pts = [];
    const steps = 72;
    for (let i = 0; i <= steps; i += 1) {
      const angle = (i / steps) * Math.PI * 2;
      const north = Math.cos(angle) * radius;
      const east = Math.sin(angle) * radius;
      pts.push(Cesium.Cartesian3.fromDegrees(
        ORIGIN.longitude + east / M_LON,
        ORIGIN.latitude + north / M_LAT,
        height
      ));
    }
    return pts;
  };

  try {
    viewer = new Cesium.Viewer('cesiumContainer', {
      animation: false,
      baseLayer: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      scene3DOnly: true,
      requestRenderMode: false
    });

    viewer.imageryLayers.removeAll();
    viewer.imageryLayers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({
      url: 'https://wmts.nlsc.gov.tw/wmts/EMAP/default/GoogleMapsCompatible/{z}/{y}/{x}',
      credit: '© 內政部國土測繪中心',
      maximumLevel: 20
    }));

    viewer.scene.globe.show = true;
    viewer.scene.globe.depthTestAgainstTerrain = false;
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#d5e0d4');
    viewer.scene.globe.showGroundAtmosphere = false;
    viewer.scene.globe.enableLighting = false;
    viewer.scene.globe.translucency.enabled = false;
    viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#c5d4c8');
    if (viewer.scene.skyBox) viewer.scene.skyBox.show = false;
    if (viewer.scene.sun) viewer.scene.sun.show = false;
    if (viewer.scene.moon) viewer.scene.moon.show = false;
    viewer.scene.skyAtmosphere.show = true;
    viewer.scene.fog.enabled = false;
    viewer.scene.light = new Cesium.DirectionalLight({
      direction: new Cesium.Cartesian3(0.35, -0.75, -0.55)
    });
    viewer.camera.setView(streetView);
    viewer.scene.requestRender();

    groundDisc = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(ORIGIN.longitude, ORIGIN.latitude),
      ellipse: {
        semiMajorAxis: 280,
        semiMinorAxis: 280,
        height: GROUND_M - 0.4,
        material: Cesium.Color.fromCssColorString('#d7e2d4')
      }
    });

    rangeEntity = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(ORIGIN.longitude, ORIGIN.latitude, GROUND_M + 2),
      point: {
        pixelSize: 12,
        color: Cesium.Color.fromCssColorString('#315a41'),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      },
      ellipse: {
        semiMajorAxis: RADIUS_M,
        semiMinorAxis: RADIUS_M,
        height: GROUND_M + 0.5,
        material: Cesium.Color.fromCssColorString('#6c8b63').withAlpha(0.1),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString('#54744e').withAlpha(0.9),
        outlineWidth: 2
      },
      label: {
        text: '鎮撫街 46 號原點',
        font: '600 15px "PingFang TC","Noto Sans TC",sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#243126'),
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 3,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -10),
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    });

    ringLine = viewer.entities.add({
      polyline: {
        positions: circlePositions(RADIUS_M, GROUND_M + 1.1),
        width: 2.5,
        material: Cesium.Color.fromCssColorString('#315a41')
      }
    });

    document.getElementById('streetButton').onclick = () => fly(streetView);
    document.getElementById('overviewButton').onclick = () => fly(overviewView);
    document.getElementById('facadeButton').onclick = () => fly(facadeView);
    document.getElementById('ringButton').onclick = () => {
      const show = !rangeEntity.show;
      rangeEntity.show = show;
      ringLine.show = show;
      document.getElementById('ringButton').setAttribute('aria-pressed', show ? 'true' : 'false');
    };
    document.querySelectorAll('[data-mode]').forEach((button) => {
      button.onclick = () => applyMode(button.dataset.mode);
    });

    const clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    clickHandler.setInputAction((event) => {
      const picked = viewer.scene.pick(event.position);
      const meta = picked && picked.id;
      if (!meta || !meta.osmId) {
        pickLine.textContent = '點選程序化樓可看類型與高度來源。';
        return;
      }
      const name = meta.name ? meta.name + '｜' : '';
      pickLine.textContent = name + meta.kindLabel + '｜' + heightLabel(meta) + '｜OSM ' + meta.osmId;
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    window.__zhenfuPreview = { mode, report, viewer };

    const tileOptions = {
      maximumScreenSpaceError: 8,
      dynamicScreenSpaceError: true,
      showCreditsOnScreen: true,
      cullWithChildrenBounds: true,
      cullRequestsWhileMoving: false
    };
    const roadOptions = {
      maximumScreenSpaceError: 12,
      dynamicScreenSpaceError: true,
      showCreditsOnScreen: true,
      cullRequestsWhileMoving: false
    };

    const loadTimeout = setTimeout(() => {
      if (report.tiles === 'loading') {
        report.tiles = 'error';
        renderStatus();
      }
    }, 90000);

    Cesium.Cesium3DTileset.fromUrl(TILESET_URL, tileOptions).then((tileset) => {
      buildingTileset = tileset;
      viewer.scene.primitives.add(tileset);
      clearTimeout(loadTimeout);
      report.tiles = 'ready';
      applyMode(mode);
      renderStatus();
    }).catch((error) => {
      console.error(error);
      clearTimeout(loadTimeout);
      report.tiles = 'error';
      renderStatus();
    });

    Cesium.Cesium3DTileset.fromUrl(ROAD_TILESET_URL, roadOptions).then((roads) => {
      roadTileset = roads;
      viewer.scene.primitives.add(roads);
      report.roads = 'ready';
      applyMode(mode);
    }).catch((error) => {
      console.warn('道路圖層暫時無法載入', error);
      report.roads = 'error';
    });

    const bundlePromise = fetch('data/buildings.json').then((response) => {
      if (!response.ok) throw new Error('bundle ' + response.status);
      return response.json();
    });

    bundlePromise.then((json) => {
      const records = normalize(json);
      buildProcedural(records, 'bundle');
      const bundleIds = idsOf(records);
      const query = '[out:json][timeout:18];way["building"](around:210,24.9979870,121.3146923);out tags geom;';
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        signal: ctrl.signal
      }).then((response) => {
        if (!response.ok) throw new Error('overpass ' + response.status);
        return response.json();
      }).then((live) => {
        const fresh = normalize(live);
        if (fresh.length >= 8 && idsOf(fresh) !== bundleIds) buildProcedural(fresh, 'overpass');
      }).catch((error) => {
        if (!error || error.name !== 'AbortError') console.warn('Overpass 暫時無法更新，繼續使用內建輪廓', error);
      }).finally(() => clearTimeout(timer));
    }).catch((error) => {
      console.error(error);
      report.procedural = 'error';
      renderStatus();
    });

    renderStatus();
  } catch (error) {
    console.error(error);
    setStatus('error', '地圖元件無法啟動，請確認瀏覽器支援 WebGL。');
  }
})();
