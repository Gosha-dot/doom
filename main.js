/*
  Doom-like (1993) browser mini-FPS using classic raycasting.

  Key idea (raycasting):
  - The world is a 2D grid map (0 = empty, >0 = wall type).
  - For each vertical column of the screen, we cast a ray from the player through the "camera plane"
    and find the first wall cell it hits (DDA grid stepping).
  - The hit distance defines the height of that wall slice on screen (pseudo-3D).
  - We draw many vertical slices next to each other -> the scene.
*/

(() => {
  "use strict";

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d", { alpha: false });

  const minimap = document.getElementById("minimap");
  const mctx = minimap.getContext("2d");

  const overlay = document.getElementById("overlay");
  const startBtn = document.getElementById("startBtn");
  const resumeBtn = document.getElementById("resumeBtn");

  const hpEl = document.getElementById("hp");
  const ammoEl = document.getElementById("ammo");
  const levelEl = document.getElementById("level");
  const moneyEl = document.getElementById("money");

  // ---------- Levels / Map (procedural, 1..20) ----------
  // We generate 20 distinct levels (rooms + corridors + themes) from a seed based on level number.
  const LEVEL_COUNT = 20;

  let levelIndex = 0; // 0..LEVEL_COUNT-1
  let LEVEL = buildLevel(levelIndex);
  let MAP = LEVEL.map;
  let MAP_W = MAP[0].length;
  let MAP_H = MAP.length;

  const isWall = (x, y) => {
    if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return true;
    return MAP[y][x] !== 0;
  };

  function buildLevel(idx) {
    const levelNo = idx + 1;
    const rng = makeRng(0xC0FFEE ^ (levelNo * 0x9e3779b9));

    // Themes rotate; later levels get darker/faster.
    const themes = [
      { name: "UAC Outpost", sky: "#0f1322", floor: "#070810", wallSet: [1, 2, 4], portal: [190, 120, 255] },
      { name: "Maintenance", sky: "#0b1222", floor: "#090a12", wallSet: [2, 4, 7], portal: [120, 190, 255] },
      { name: "Toxic Tunnels", sky: "#061816", floor: "#07110d", wallSet: [3, 6, 2], portal: [120, 255, 170] },
      { name: "Hellish Bricks", sky: "#1a0b0b", floor: "#0f0505", wallSet: [1, 5, 2], portal: [255, 120, 120] },
      { name: "Cold Tech", sky: "#0a1020", floor: "#050712", wallSet: [4, 2, 3], portal: [160, 160, 255] },
    ];
    const theme = themes[idx % themes.length];

    const size = 28 + ((idx % 5) * 3); // 28,31,34,37,40 (bigger + more variety)
    const map = generateRoomsAndCorridors(size, size, rng, theme.wallSet);

    const start = findStartCell(map);
    const portal = findFarthestCell(map, start.x, start.y);

    // Enemy spawns: scale count/difficulty with level.
    const enemyCount = clamp(4 + Math.floor(levelNo * 0.55), 4, 14);
    const enemyCandidates = pickEmptyCellsFarFrom(map, rng, start.x, start.y, enemyCount * 3, 6);

    // Decorations: barrels/lamps/computers (non-blocking) for detail.
    const decoCount = clamp(10 + Math.floor(levelNo * 0.9), 10, 36);
    const decoCells = pickEmptyCellsFarFrom(map, rng, start.x, start.y, decoCount, 2);
    const decorations = decoCells.map((p) => {
      const roll = rng();
      const type = roll < 0.45 ? "barrel" : roll < 0.75 ? "lamp" : "terminal";
      return { x: p.x + 0.5, y: p.y + 0.5, type };
    });

    const doors = buildDoorRooms(map, rng, start.x, start.y, portal.x, portal.y, levelNo);
    const minibossSpawn = findBossSpawn(map, portal.x, portal.y);

    return {
      index: idx,
      name: `Level ${levelNo}: ${theme.name}`,
      start: { x: start.x + 0.5, y: start.y + 0.5 },
      portal: { x: portal.x + 0.5, y: portal.y + 0.5, rgb: theme.portal },
      map,
      enemyCandidates: enemyCandidates.map((p) => [p.x + 0.5, p.y + 0.5]),
      decorations,
      theme,
      doors,
      minibossSpawn: { x: minibossSpawn.x + 0.5, y: minibossSpawn.y + 0.5 },
      portalLocked: true,
    };
  }

  function findBossSpawn(map, px, py) {
    // Find a nearby empty cell around the portal for the miniboss.
    const w = map[0].length;
    const h = map.length;
    for (let r = 1; r <= 6; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = px + dx;
          const y = py + dy;
          if (x <= 1 || y <= 1 || x >= w - 2 || y >= h - 2) continue;
          if (map[y][x] === 0) return { x, y };
        }
      }
    }
    return { x: px, y: py };
  }

  function buildDoorRooms(map, rng, sx, sy, px, py, levelNo) {
    // Create a few locked doors (tile id 8) that open after clearing enemies in the region behind them.
    // We pick corridor "choke points": empty cell with exactly 2 opposite open neighbors.
    const w = map[0].length;
    const h = map.length;
    const candidates = [];
    for (let y = 2; y < h - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        if (map[y][x] !== 0) continue;

        const left = map[y][x - 1] === 0;
        const right = map[y][x + 1] === 0;
        const up = map[y - 1][x] === 0;
        const down = map[y + 1][x] === 0;
        const openCount = (left ? 1 : 0) + (right ? 1 : 0) + (up ? 1 : 0) + (down ? 1 : 0);
        const isChokeH = left && right && !up && !down;
        const isChokeV = up && down && !left && !right;
        // Allow only true corridor segments (no junctions/rooms): exactly 2 opposite neighbors open.
        if (openCount !== 2 || (!isChokeH && !isChokeV)) continue;

        // Avoid too close to start/portal.
        const ds = (x - sx) * (x - sx) + (y - sy) * (y - sy);
        const dp = (x - px) * (x - px) + (y - py) * (y - py);
        if (ds < 25 || dp < 25) continue;
        candidates.push({ x, y, ds });
      }
    }
    candidates.sort((a, b) => b.ds - a.ds);

    const doorCount = clamp(2 + Math.floor(levelNo / 6), 2, 5);
    const doors = [];

    // Try more candidates so we actually end up with doors even on open maps.
    let attempts = 0;
    while (doors.length < doorCount && candidates.length > 0 && attempts < 80) {
      attempts++;
      const pickIndex = Math.min(candidates.length - 1, ((rng() * 6) | 0));
      const c = candidates.splice(pickIndex, 1)[0];
      // Place door tile
      map[c.y][c.x] = 8;

      // Determine which side is "behind" the door: pick the side that is farther from start.
      const sides = [
        { x: c.x - 1, y: c.y },
        { x: c.x + 1, y: c.y },
        { x: c.x, y: c.y - 1 },
        { x: c.x, y: c.y + 1 },
      ].filter((p) => map[p.y][p.x] === 0);

      let best = sides[0] || { x: c.x, y: c.y };
      let bestD = -1;
      for (const s of sides) {
        const d = (s.x - sx) * (s.x - sx) + (s.y - sy) * (s.y - sy);
        if (d > bestD) {
          bestD = d;
          best = s;
        }
      }

      const region = floodRegion(map, best.x, best.y, 4200, /*treatDoorAsWall*/ true);
      if (region.cells.length < 18) {
        // Too tiny; revert door
        map[c.y][c.x] = 0;
        continue;
      }

      // Pick a few spawn points in this region
      const spawns = [];
      const spawnN = clamp(2 + ((levelNo / 7) | 0), 2, 5);
      for (let k = 0; k < spawnN && region.cells.length > 0; k++) {
        const t = region.cells[(rng() * region.cells.length) | 0];
        spawns.push([t.x + 0.5, t.y + 0.5]);
      }

      doors.push({
        x: c.x,
        y: c.y,
        open: false,
        regionCells: region.cells, // for debug/minimap; also used for grouping
        spawnPoints: spawns,
        enemyIds: [],
      });
    }

    return doors;
  }

  function floodRegion(map, sx, sy, limit, treatDoorAsWall) {
    const h = map.length;
    const w = map[0].length;
    const seen = new Uint8Array(w * h);
    const cells = [];
    const qx = new Int16Array(w * h);
    const qy = new Int16Array(w * h);
    let qh = 0;
    let qt = 0;
    const idx0 = sy * w + sx;
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return { cells };
    if (map[sy][sx] !== 0) return { cells };
    seen[idx0] = 1;
    qx[qt] = sx;
    qy[qt] = sy;
    qt++;
    while (qh < qt && cells.length < limit) {
      const x = qx[qh];
      const y = qy[qh];
      qh++;
      cells.push({ x, y });
      const neigh = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ];
      for (const [nx, ny] of neigh) {
        if (nx <= 0 || ny <= 0 || nx >= w - 1 || ny >= h - 1) continue;
        const v = map[ny][nx];
        if (v !== 0) {
          if (!(treatDoorAsWall && v === 8)) continue;
          continue;
        }
        const id = ny * w + nx;
        if (seen[id]) continue;
        seen[id] = 1;
        qx[qt] = nx;
        qy[qt] = ny;
        qt++;
      }
    }
    return { cells };
  }

  function makeRng(seed) {
    // Deterministic LCG RNG: returns float in [0,1).
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function generateRoomsAndCorridors(w, h, rng, wallSet) {
    // 0 = empty; wall IDs from wallSet.
    const map = Array.from({ length: h }, () => Array.from({ length: w }, () => 1));

    const pickWall = () => wallSet[(rng() * wallSet.length) | 0];

    // Fill with random walls for variety (still solid), then carve.
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) map[y][x] = pickWall();

    // Borders solid.
    for (let x = 0; x < w; x++) {
      map[0][x] = pickWall();
      map[h - 1][x] = pickWall();
    }
    for (let y = 0; y < h; y++) {
      map[y][0] = pickWall();
      map[y][w - 1] = pickWall();
    }

    const rooms = [];
    const roomCount = 10 + ((rng() * 9) | 0);

    for (let i = 0; i < roomCount; i++) {
      const rw = 5 + ((rng() * 10) | 0);
      const rh = 5 + ((rng() * 10) | 0);
      const rx = 1 + ((rng() * (w - rw - 2)) | 0);
      const ry = 1 + ((rng() * (h - rh - 2)) | 0);

      // Slight overlap allowed; carve anyway for more organic shapes.
      for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) map[y][x] = 0;
      rooms.push({ x: rx, y: ry, w: rw, h: rh, cx: (rx + (rw / 2)) | 0, cy: (ry + (rh / 2)) | 0 });
    }

    // Connect rooms with corridors.
    for (let i = 1; i < rooms.length; i++) {
      const a = rooms[i - 1];
      const b = rooms[i];
      if (rng() < 0.5) {
        carveH(map, a.cx, b.cx, a.cy);
        carveV(map, a.cy, b.cy, b.cx);
      } else {
        carveV(map, a.cy, b.cy, a.cx);
        carveH(map, a.cx, b.cx, b.cy);
      }
    }

    // Add some extra loops for less linear maps.
    for (let i = 0; i < 9; i++) {
      const a = rooms[(rng() * rooms.length) | 0];
      const b = rooms[(rng() * rooms.length) | 0];
      carveH(map, a.cx, b.cx, a.cy);
      carveV(map, a.cy, b.cy, b.cx);
    }

    // Sprinkle pillars (walls) inside some rooms for detail/cover.
    const pillarCount = 18 + ((rng() * 28) | 0);
    for (let i = 0; i < pillarCount; i++) {
      const x = 2 + ((rng() * (w - 4)) | 0);
      const y = 2 + ((rng() * (h - 4)) | 0);
      if (map[y][x] !== 0) continue;
      if (rng() < 0.55) map[y][x] = pickWall();
    }

    return map;
  }

  function carveH(map, x0, x1, y) {
    const w = map[0].length;
    const h = map.length;
    if (y <= 0 || y >= h - 1) return;
    const a = Math.max(1, Math.min(x0, x1));
    const b = Math.min(w - 2, Math.max(x0, x1));
    for (let x = a; x <= b; x++) map[y][x] = 0;
  }

  function carveV(map, y0, y1, x) {
    const w = map[0].length;
    const h = map.length;
    if (x <= 0 || x >= w - 1) return;
    const a = Math.max(1, Math.min(y0, y1));
    const b = Math.min(h - 2, Math.max(y0, y1));
    for (let y = a; y <= b; y++) map[y][x] = 0;
  }

  function findStartCell(map) {
    // Find a "good" start near the first open area; fallback to first empty.
    for (let y = 1; y < map.length - 1; y++) {
      for (let x = 1; x < map[0].length - 1; x++) {
        if (map[y][x] !== 0) continue;
        // Need some breathing room
        if (map[y][x + 1] === 0 && map[y + 1][x] === 0) return { x, y };
      }
    }
    for (let y = 1; y < map.length - 1; y++) for (let x = 1; x < map[0].length - 1; x++) if (map[y][x] === 0) return { x, y };
    return { x: 1, y: 1 };
  }

  function findFarthestCell(map, sx, sy) {
    const dist = bfsDistances(map, sx, sy);
    let best = { x: sx, y: sy, d: -1 };
    for (let y = 1; y < map.length - 1; y++) {
      for (let x = 1; x < map[0].length - 1; x++) {
        const d = dist[y][x];
        if (d > best.d) best = { x, y, d };
      }
    }
    return { x: best.x, y: best.y };
  }

  function bfsDistances(map, sx, sy) {
    const h = map.length;
    const w = map[0].length;
    const dist = Array.from({ length: h }, () => Array.from({ length: w }, () => -1));
    const qx = new Int16Array(w * h);
    const qy = new Int16Array(w * h);
    let qh = 0;
    let qt = 0;
    dist[sy][sx] = 0;
    qx[qt] = sx;
    qy[qt] = sy;
    qt++;
    while (qh < qt) {
      const x = qx[qh];
      const y = qy[qh];
      qh++;
      const nd = dist[y][x] + 1;
      // 4-neighbors
      if (x > 1 && map[y][x - 1] === 0 && dist[y][x - 1] === -1) {
        dist[y][x - 1] = nd;
        qx[qt] = x - 1;
        qy[qt] = y;
        qt++;
      }
      if (x < w - 2 && map[y][x + 1] === 0 && dist[y][x + 1] === -1) {
        dist[y][x + 1] = nd;
        qx[qt] = x + 1;
        qy[qt] = y;
        qt++;
      }
      if (y > 1 && map[y - 1][x] === 0 && dist[y - 1][x] === -1) {
        dist[y - 1][x] = nd;
        qx[qt] = x;
        qy[qt] = y - 1;
        qt++;
      }
      if (y < h - 2 && map[y + 1][x] === 0 && dist[y + 1][x] === -1) {
        dist[y + 1][x] = nd;
        qx[qt] = x;
        qy[qt] = y + 1;
        qt++;
      }
    }
    return dist;
  }

  function pickEmptyCellsFarFrom(map, rng, sx, sy, count, minDist) {
    const dist = bfsDistances(map, sx, sy);
    const candidates = [];
    for (let y = 1; y < map.length - 1; y++) {
      for (let x = 1; x < map[0].length - 1; x++) {
        if (map[y][x] !== 0) continue;
        const d = dist[y][x];
        if (d >= minDist) candidates.push({ x, y, d });
      }
    }
    // Shuffle-ish selection
    const out = [];
    for (let i = 0; i < count && candidates.length > 0; i++) {
      const k = (rng() * candidates.length) | 0;
      out.push(candidates[k]);
      candidates.splice(k, 1);
    }
    return out;
  }

  // ---------- Player ----------
  const player = {
    // Start inside an empty cell (MAP[y][x] === 0)
    x: LEVEL.start.x,
    y: LEVEL.start.y,
    // Direction vector (where we look)
    dirX: 1,
    dirY: 0,
    // Camera plane (perpendicular to dir; defines FOV)
    // FOV ~ 2*atan(|plane|) => |plane| ~ 0.66 is classic ~66°
    planeX: 0,
    planeY: 0.66,
    radius: 0.18,
    hp: 100,
    ammo: 50,
    money: 0,
  };

  // ---------- Input ----------
  // Track both layout-independent physical keys (event.code) and layout-dependent characters (event.key).
  // `code` should work across layouts; `key` is a fallback for some IME/locale edge cases.
  const codesDown = new Set();
  const keysDown = new Set();
  let pointerLocked = false;
  let paused = true;

  const mouse = {
    sensitivity: 0.0022, // radians per px
  };

  window.addEventListener("keydown", (e) => {
    if (e.code === "Escape") {
      // Let the browser release pointer lock naturally, then show overlay in pointerlockchange.
      if (pointerLocked) document.exitPointerLock();
    }
    codesDown.add(e.code);
    if (typeof e.key === "string") keysDown.add(e.key.toLowerCase());
  });
  window.addEventListener("keyup", (e) => {
    codesDown.delete(e.code);
    if (typeof e.key === "string") keysDown.delete(e.key.toLowerCase());
  });

  function onMouseMove(e) {
    if (!pointerLocked || paused) return;
    // Mouse look (no inversion): move mouse right -> look right
    const yaw = e.movementX * mouse.sensitivity;
    rotatePlayer(yaw);
  }

  // ---------- Audio (shot SFX via WebAudio; no external files) ----------
  // The first user gesture must create/resume AudioContext.
  const audio = {
    ctx: null,
    unlocked: false,
  };

  function ensureAudio() {
    if (audio.ctx) return audio.ctx;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    audio.ctx = new AudioCtx();
    return audio.ctx;
  }

  function playShotSound() {
    const actx = ensureAudio();
    // Simple "gun" click + noise burst.
    const t0 = actx.currentTime;

    const osc = actx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(170, t0);
    osc.frequency.exponentialRampToValueAtTime(60, t0 + 0.05);

    const gain = actx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.08);

    // Noise burst (white noise)
    const buffer = actx.createBuffer(1, Math.floor(actx.sampleRate * 0.06), actx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const noise = actx.createBufferSource();
    noise.buffer = buffer;

    const noiseGain = actx.createGain();
    noiseGain.gain.setValueAtTime(0.18, t0);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.06);

    const filter = actx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(1800, t0);

    osc.connect(gain).connect(filter).connect(actx.destination);
    noise.connect(noiseGain).connect(filter);

    osc.start(t0);
    osc.stop(t0 + 0.09);
    noise.start(t0);
    noise.stop(t0 + 0.07);
  }

  // ---------- Walls "textures" (procedural, sampled per column) ----------
  const TEX_SIZE = 64;
  const wallTextures = makeWallTextures();

  function makeWallTextures() {
    const mk = (drawFn) => {
      const c = document.createElement("canvas");
      c.width = TEX_SIZE;
      c.height = TEX_SIZE;
      const cctx = c.getContext("2d");
      drawFn(cctx);
      return cctx.getImageData(0, 0, TEX_SIZE, TEX_SIZE);
    };

    const tex = [];
    tex[1] = mk((c) => {
      // Red bricks
      c.fillStyle = "#6b1d1d";
      c.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
      c.fillStyle = "rgba(0,0,0,0.25)";
      for (let y = 0; y < TEX_SIZE; y += 16) c.fillRect(0, y, TEX_SIZE, 2);
      for (let y = 0; y < TEX_SIZE; y += 16) {
        const offset = (y / 16) % 2 ? 8 : 0;
        for (let x = -offset; x < TEX_SIZE; x += 16) c.fillRect(x + 14, y, 2, 16);
      }
      c.fillStyle = "rgba(255,255,255,0.08)";
      for (let i = 0; i < 140; i++) c.fillRect((Math.random() * TEX_SIZE) | 0, (Math.random() * TEX_SIZE) | 0, 1, 1);
    });
    tex[2] = mk((c) => {
      // Concrete
      c.fillStyle = "#3b3f47";
      c.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
      for (let i = 0; i < 220; i++) {
        const g = 110 + (Math.random() * 80) | 0;
        c.fillStyle = `rgba(${g},${g},${g},0.18)`;
        c.fillRect((Math.random() * TEX_SIZE) | 0, (Math.random() * TEX_SIZE) | 0, 2, 2);
      }
      c.strokeStyle = "rgba(0,0,0,0.25)";
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(0, 8);
      c.lineTo(TEX_SIZE, 12);
      c.moveTo(6, 28);
      c.lineTo(TEX_SIZE, 24);
      c.stroke();
    });
    tex[3] = mk((c) => {
      // Green panels
      c.fillStyle = "#1f3a2b";
      c.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
      c.fillStyle = "rgba(0,0,0,0.25)";
      for (let y = 0; y < TEX_SIZE; y += 8) c.fillRect(0, y, TEX_SIZE, 1);
      c.strokeStyle = "rgba(255,255,255,0.08)";
      c.lineWidth = 2;
      c.strokeRect(6, 6, TEX_SIZE - 12, TEX_SIZE - 12);
      c.strokeRect(14, 14, TEX_SIZE - 28, TEX_SIZE - 28);
    });
    tex[4] = mk((c) => {
      // Blue tech
      c.fillStyle = "#1c2b4a";
      c.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
      for (let x = 0; x < TEX_SIZE; x += 8) {
        c.fillStyle = x % 16 ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.18)";
        c.fillRect(x, 0, 2, TEX_SIZE);
      }
      c.fillStyle = "rgba(0,0,0,0.25)";
      c.fillRect(0, 28, TEX_SIZE, 8);
      c.fillStyle = "rgba(255,255,255,0.08)";
      for (let i = 0; i < 10; i++) c.fillRect(6 + i * 5, 30, 2, 4);
    });
    // Map wall ids 5..7 to existing patterns for variety
    tex[5] = tex[1];
    tex[6] = tex[3];
    tex[7] = tex[2];
    tex[8] = mk((c) => {
      // Door (metal/wood strips)
      c.fillStyle = "#3a2e22";
      c.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
      c.fillStyle = "rgba(0,0,0,0.28)";
      for (let x = 0; x < TEX_SIZE; x += 8) c.fillRect(x, 0, 2, TEX_SIZE);
      c.fillStyle = "rgba(255,255,255,0.08)";
      for (let y = 6; y < TEX_SIZE; y += 14) c.fillRect(0, y, TEX_SIZE, 2);
      c.fillStyle = "#1b1410";
      c.fillRect(44, 30, 6, 6); // handle-ish
      c.fillStyle = "rgba(255,255,255,0.10)";
      c.fillRect(45, 31, 2, 2);
    });
    return tex;
  }

  // ---------- Enemies / Projectiles ----------
  const enemies = [];
  const bullets = []; // enemy projectiles

  const ENEMY_TYPES = makeEnemyTypes();
  const DECO_SPRITES = makeDecoSprites();

  function makeEnemyTypes() {
    // "Models" are classic billboard sprites (small pixel-art canvases) with 2-frame animation.
    const types = {
      grunt: {
        name: "Grunt",
        hp: 30,
        radius: 0.26,
        speed: 1.05,
        meleeDamage: 6,
        bullet: { speed: 6.2, damage: 5, rgb: [255, 220, 120] },
        shootRange: 9.0,
        shootCooldown: [0.85, 1.25],
        frames: makeSpriteFrames("grunt", ["#b8c2d1", "#7a2b2b", "#2a2f3a"]),
        scale: 0.9,
        reward: 15,
      },
      imp: {
        name: "Imp",
        hp: 45,
        radius: 0.28,
        speed: 1.2,
        meleeDamage: 8,
        bullet: { speed: 5.6, damage: 7, rgb: [255, 150, 80] },
        shootRange: 10.0,
        shootCooldown: [1.0, 1.45],
        frames: makeSpriteFrames("imp", ["#a66a2b", "#ffb25c", "#2a1206"]),
        scale: 1.0,
        reward: 25,
      },
      caco: {
        name: "Caco",
        hp: 70,
        radius: 0.34,
        speed: 0.95,
        meleeDamage: 10,
        bullet: { speed: 4.9, damage: 10, rgb: [255, 90, 90] },
        shootRange: 11.0,
        shootCooldown: [1.25, 1.75],
        frames: makeSpriteFrames("caco", ["#d33a3a", "#ffcf70", "#1a0606"]),
        scale: 1.25,
        yOffset: -0.18,
        reward: 45,
      },
      miniboss: {
        name: "MiniBoss",
        hp: 180,
        radius: 0.42,
        speed: 0.85,
        meleeDamage: 14,
        bullet: { speed: 5.0, damage: 12, rgb: [200, 120, 255] },
        shootRange: 12.0,
        shootCooldown: [0.95, 1.25],
        frames: makeSpriteFrames("miniboss", ["#6f4bd6", "#ffd36b", "#160621"]),
        scale: 1.55,
        yOffset: -0.05,
        reward: 120,
      },
    };
    return types;
  }

  function makeDecoSprites() {
    return {
      barrel: makeDecoSprite("barrel"),
      lamp: makeDecoSprite("lamp"),
      terminal: makeDecoSprite("terminal"),
    };
  }

  function makeSpriteFrames(kind, palette) {
    // Returns [frame0, frame1] canvases (64x64, transparent).
    const f0 = makeEnemySprite(kind, palette, 0);
    const f1 = makeEnemySprite(kind, palette, 1);
    return [f0, f1];
  }

  function makeEnemySprite(kind, palette, frame) {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 64;
    const g = c.getContext("2d");
    g.clearRect(0, 0, 64, 64);

    const [base, hi, shadow] = palette;

    // Basic pixel-art using rectangles (keeps it "file-only" without PNGs).
    // Slight offsets per frame to simulate walking.
    const wob = frame === 0 ? 0 : 1;

    if (kind === "grunt") {
      // Helmet
      g.fillStyle = shadow;
      g.fillRect(22, 10, 20, 12);
      g.fillStyle = base;
      g.fillRect(23, 11, 18, 10);
      g.fillStyle = "rgba(255,255,255,0.10)";
      g.fillRect(25, 12, 4, 6);

      // Face visor
      g.fillStyle = "#1d232c";
      g.fillRect(26, 15, 12, 4);

      // Torso
      g.fillStyle = shadow;
      g.fillRect(20, 22, 24, 18);
      g.fillStyle = base;
      g.fillRect(21, 23, 22, 16);

      // Arms
      g.fillStyle = base;
      g.fillRect(16, 24, 5, 14);
      g.fillRect(43, 24, 5, 14);

      // Gun
      g.fillStyle = "#2b2f3a";
      g.fillRect(30, 30, 16, 5);
      g.fillStyle = "#0e0f14";
      g.fillRect(40, 29, 6, 2);

      // Legs
      g.fillStyle = shadow;
      g.fillRect(24 + wob, 40, 7, 16);
      g.fillRect(33 - wob, 40, 7, 16);
      g.fillStyle = hi;
      g.fillRect(25 + wob, 41, 5, 14);
      g.fillRect(34 - wob, 41, 5, 14);
    } else if (kind === "imp") {
      // Head
      g.fillStyle = shadow;
      g.fillRect(20, 10, 24, 18);
      g.fillStyle = base;
      g.fillRect(21, 11, 22, 16);
      g.fillStyle = hi;
      g.fillRect(24, 14, 4, 4);
      g.fillRect(36, 14, 4, 4);
      g.fillStyle = "#140704";
      g.fillRect(28, 20, 8, 3);

      // Horns
      g.fillStyle = shadow;
      g.fillRect(18, 8, 6, 6);
      g.fillRect(40, 8, 6, 6);

      // Body
      g.fillStyle = shadow;
      g.fillRect(18, 28, 28, 18);
      g.fillStyle = base;
      g.fillRect(19, 29, 26, 16);

      // Arms (raised in frame1)
      g.fillStyle = base;
      const armY = frame === 0 ? 30 : 27;
      g.fillRect(14, armY, 6, 18);
      g.fillRect(44, armY, 6, 18);
      g.fillStyle = hi;
      g.fillRect(15, armY + 2, 4, 6);
      g.fillRect(45, armY + 2, 4, 6);

      // Legs
      g.fillStyle = shadow;
      g.fillRect(23 + wob, 46, 8, 14);
      g.fillRect(33 - wob, 46, 8, 14);
      g.fillStyle = base;
      g.fillRect(24 + wob, 47, 6, 12);
      g.fillRect(34 - wob, 47, 6, 12);
    } else if (kind === "miniboss") {
      // Larger demon
      g.fillStyle = shadow;
      g.fillRect(16, 10, 32, 28);
      g.fillStyle = base;
      g.fillRect(17, 11, 30, 26);

      // horns
      g.fillStyle = shadow;
      g.fillRect(12, 8, 8, 10);
      g.fillRect(44, 8, 8, 10);
      g.fillStyle = base;
      g.fillRect(13, 9, 6, 8);
      g.fillRect(45, 9, 6, 8);

      // eyes
      g.fillStyle = hi;
      g.fillRect(22, 18 + (frame ? 1 : 0), 4, 4);
      g.fillRect(38, 18 + (frame ? 1 : 0), 4, 4);
      g.fillStyle = "#120515";
      g.fillRect(28, 26, 8, 4);

      // body
      g.fillStyle = shadow;
      g.fillRect(14, 38, 36, 18);
      g.fillStyle = base;
      g.fillRect(15, 39, 34, 16);

      // arms
      g.fillStyle = base;
      g.fillRect(8, 38 + (frame ? -1 : 0), 8, 18);
      g.fillRect(48, 38 + (frame ? -1 : 0), 8, 18);
      g.fillStyle = hi;
      g.fillRect(10, 42, 4, 6);
      g.fillRect(50, 42, 4, 6);
    } else {
      // Caco: round floating monster
      g.fillStyle = shadow;
      g.beginPath();
      g.arc(32, 30, 18, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = base;
      g.beginPath();
      g.arc(32, 29, 17, 0, Math.PI * 2);
      g.fill();

      // Mouth
      g.fillStyle = "#140707";
      g.fillRect(24, 34, 16, 6);
      g.fillStyle = hi;
      for (let i = 0; i < 8; i++) g.fillRect(24 + i * 2, 40, 1, 3);

      // Eye
      g.fillStyle = "#101317";
      g.fillRect(28, 18 + wob, 8, 6);
      g.fillStyle = "#f8f2c0";
      g.fillRect(31, 20 + wob, 2, 2);

      // Tiny hands
      g.fillStyle = base;
      g.fillRect(14, 30, 6, 5);
      g.fillRect(44, 30, 6, 5);

      // Shadow-ish underside
      g.fillStyle = "rgba(0,0,0,0.25)";
      g.fillRect(18, 44, 28, 6);
    }

    // Outline (cheap 1px stroke look)
    g.globalCompositeOperation = "source-atop";
    g.fillStyle = "rgba(0,0,0,0.18)";
    g.fillRect(0, 0, 64, 64);
    g.globalCompositeOperation = "source-over";

    return c;
  }

  function makeDecoSprite(kind) {
    const c = document.createElement("canvas");
    c.width = 48;
    c.height = 64;
    const g = c.getContext("2d");
    g.clearRect(0, 0, c.width, c.height);

    if (kind === "barrel") {
      g.fillStyle = "#2f3e47";
      g.fillRect(14, 14, 20, 38);
      g.fillStyle = "rgba(255,255,255,0.10)";
      g.fillRect(16, 16, 4, 34);
      g.fillStyle = "#0d1014";
      g.fillRect(14, 20, 20, 2);
      g.fillRect(14, 32, 20, 2);
      g.fillRect(14, 44, 20, 2);
      g.fillStyle = "#2aa84a";
      g.fillRect(17, 26, 14, 10);
    } else if (kind === "lamp") {
      g.fillStyle = "#2a2f3a";
      g.fillRect(22, 10, 4, 44);
      g.fillStyle = "#0e0f14";
      g.fillRect(18, 50, 12, 6);
      g.fillStyle = "#f8f2c0";
      g.fillRect(16, 18, 16, 10);
      g.fillStyle = "rgba(255,255,255,0.25)";
      g.fillRect(18, 20, 12, 6);
    } else {
      // terminal
      g.fillStyle = "#2a2f3a";
      g.fillRect(10, 18, 28, 32);
      g.fillStyle = "#0e0f14";
      g.fillRect(12, 20, 24, 18);
      g.fillStyle = "#37ff7a";
      for (let i = 0; i < 7; i++) g.fillRect(14 + i * 3, 22 + (i % 3), 2, 2);
      g.fillStyle = "rgba(255,255,255,0.10)";
      g.fillRect(12, 40, 24, 8);
    }

    return c;
  }

  function spawnEnemies() {
    // Place enemies in empty spaces (validated against current level map).
    const out = [];
    const levelNo = LEVEL.index + 1;
    const typePool = levelNo < 5 ? ["grunt", "imp"] : levelNo < 12 ? ["grunt", "imp", "imp"] : ["imp", "caco", "grunt"];
    for (const [x, y] of LEVEL.enemyCandidates) {
      const typeKey = typePool[(Math.random() * typePool.length) | 0];
      const e = makeEnemy(x, y, typeKey);
      if (canOccupyCircle(e.x, e.y, e.radius)) out.push(e);
      // scale enemy amount by level
      const cap = clamp(5 + Math.floor(levelNo * 0.35), 5, 12);
      if (out.length >= cap) break;
    }

    // Enemies inside locked-door rooms (must clear to open).
    for (const d of LEVEL.doors) {
      d.enemyIds = [];
      for (const [x, y] of d.spawnPoints) {
        const typeKey = levelNo < 10 ? "grunt" : (Math.random() < 0.6 ? "imp" : "grunt");
        const e = makeEnemy(x, y, typeKey);
        e.doorTag = `${d.x},${d.y}`;
        if (canOccupyCircle(e.x, e.y, e.radius)) {
          out.push(e);
          d.enemyIds.push(getEnemyId(e));
        }
      }
    }

    // Mini boss near portal each level (must be killed to unlock portal).
    const boss = makeEnemy(LEVEL.minibossSpawn.x, LEVEL.minibossSpawn.y, "miniboss");
    boss.isMiniBoss = true;
    if (canOccupyCircle(boss.x, boss.y, boss.radius)) out.push(boss);

    return out;
  }

  function makeEnemy(x, y, typeKey) {
    const type = ENEMY_TYPES[typeKey] || ENEMY_TYPES.grunt;
    return {
      x,
      y,
      typeKey,
      id: nextEnemyId++,
      radius: type.radius,
      hp: type.hp,
      alive: true,
      // Animation
      animT: Math.random() * 10,
      // AI state
      cooldown: 0, // melee
      shootCooldown: 0,
    };
  }

  let nextEnemyId = 1;
  function getEnemyId(e) {
    return e.id;
  }

  // ---------- Rendering config ----------
  const render = {
    // internal low-res buffer for a pixelated feel; scaled up to canvas size
    w: 320,
    h: 180,
    maxDepth: 30,
    wallScale: 1.0,
  };

  const bufferCanvas = document.createElement("canvas");
  const bctx = bufferCanvas.getContext("2d", { alpha: false });
  bufferCanvas.width = render.w;
  bufferCanvas.height = render.h;

  // Per-column depth buffer for sprites occlusion.
  let zBuffer = new Float32Array(render.w);

  // ---------- Weapon (simple HUD sprite with bob + recoil) ----------
  const weapon = {
    bobT: 0,
    bobAmt: 0,
    recoilT: 0,
    flashT: 0,
    sprite: makeWeaponSprite(),
  };

  function makeWeaponSprite() {
    // Procedural pixel-ish "shotgun" sprite (kept code-only; no external assets).
    const w = 220;
    const h = 150;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const cctx = c.getContext("2d");

    // Transparent background
    cctx.clearRect(0, 0, w, h);

    // Barrel
    cctx.fillStyle = "#3d404a";
    cctx.fillRect(95, 40, 30, 70);
    cctx.fillStyle = "#2a2c33";
    cctx.fillRect(100, 40, 20, 70);

    // Pump
    cctx.fillStyle = "#5b3a23";
    cctx.fillRect(78, 75, 64, 26);
    cctx.fillStyle = "rgba(255,255,255,0.08)";
    for (let i = 0; i < 8; i++) cctx.fillRect(82 + i * 7, 78, 2, 20);

    // Body
    cctx.fillStyle = "#3a3c44";
    cctx.fillRect(60, 95, 100, 35);
    cctx.fillStyle = "#1c1d22";
    cctx.fillRect(64, 100, 92, 10);

    // Stock
    cctx.fillStyle = "#5a3a23";
    cctx.fillRect(140, 102, 70, 22);
    cctx.fillStyle = "#3f2818";
    cctx.fillRect(170, 100, 40, 26);

    // Outline
    cctx.strokeStyle = "rgba(0,0,0,0.6)";
    cctx.lineWidth = 4;
    cctx.strokeRect(58, 92, 104, 40);

    // Small highlights
    cctx.fillStyle = "rgba(255,255,255,0.10)";
    cctx.fillRect(96, 42, 6, 66);
    cctx.fillRect(66, 97, 16, 6);

    return c;
  }

  // ---------- Game loop ----------
  let lastT = performance.now();
  let rafId = 0;

  function tick(t) {
    const dt = Math.min(0.05, (t - lastT) / 1000);
    lastT = t;

    if (!paused) {
      update(dt);
      draw();
    } else {
      // keep minimap + background visible even while paused
      drawPausedBackdrop();
    }

    rafId = requestAnimationFrame(tick);
  }

  // ---------- Raycasting (DDA) ----------
  function castRay(rayDirX, rayDirY) {
    // Grid cell coordinates
    let mapX = Math.floor(player.x);
    let mapY = Math.floor(player.y);

    // Length of ray from one x or y-side to next x or y-side
    const deltaDistX = rayDirX === 0 ? 1e30 : Math.abs(1 / rayDirX);
    const deltaDistY = rayDirY === 0 ? 1e30 : Math.abs(1 / rayDirY);

    let stepX = 0;
    let stepY = 0;
    let sideDistX = 0;
    let sideDistY = 0;

    // Calculate step and initial sideDist
    if (rayDirX < 0) {
      stepX = -1;
      sideDistX = (player.x - mapX) * deltaDistX;
    } else {
      stepX = 1;
      sideDistX = (mapX + 1.0 - player.x) * deltaDistX;
    }
    if (rayDirY < 0) {
      stepY = -1;
      sideDistY = (player.y - mapY) * deltaDistY;
    } else {
      stepY = 1;
      sideDistY = (mapY + 1.0 - player.y) * deltaDistY;
    }

    // Perform DDA: step cell-by-cell until we hit a wall
    let hit = 0;
    let side = 0; // 0 = hit vertical side (x), 1 = horizontal side (y)
    while (hit === 0) {
      if (sideDistX < sideDistY) {
        sideDistX += deltaDistX;
        mapX += stepX;
        side = 0;
      } else {
        sideDistY += deltaDistY;
        mapY += stepY;
        side = 1;
      }
      if (isWall(mapX, mapY)) hit = 1;
      // Safety break (should never happen in closed maps)
      if (Math.abs(mapX - player.x) + Math.abs(mapY - player.y) > 1000) break;
    }

    const wallId = (mapX >= 0 && mapY >= 0 && mapX < MAP_W && mapY < MAP_H) ? MAP[mapY][mapX] : 1;

    // Perpendicular distance to avoid fish-eye:
    // If we hit a vertical side: distance is based on X intersection; otherwise Y.
    let perpWallDist = 0;
    if (side === 0) perpWallDist = (mapX - player.x + (1 - stepX) / 2) / rayDirX;
    else perpWallDist = (mapY - player.y + (1 - stepY) / 2) / rayDirY;

    // Exact hit position on the wall, for texturing (0..1)
    let wallX = 0;
    if (side === 0) wallX = player.y + perpWallDist * rayDirY;
    else wallX = player.x + perpWallDist * rayDirX;
    wallX -= Math.floor(wallX);

    return { wallId, mapX, mapY, side, perpWallDist, wallX };
  }

  function drawWorld() {
    // Sky + floor
    bctx.fillStyle = LEVEL.theme.sky;
    bctx.fillRect(0, 0, render.w, render.h / 2);
    bctx.fillStyle = LEVEL.theme.floor;
    bctx.fillRect(0, render.h / 2, render.w, render.h / 2);

    // Raycast vertical stripes
    for (let x = 0; x < render.w; x++) {
      // cameraX in range [-1, 1]
      const cameraX = (2 * x) / render.w - 1;
      const rayDirX = player.dirX + player.planeX * cameraX;
      const rayDirY = player.dirY + player.planeY * cameraX;

      const hit = castRay(rayDirX, rayDirY);
      const dist = Math.max(0.0001, hit.perpWallDist);
      zBuffer[x] = dist;

      // Wall slice height
      const lineH = Math.floor((render.h / dist) * render.wallScale);
      let drawStart = (-lineH / 2 + render.h / 2) | 0;
      let drawEnd = (lineH / 2 + render.h / 2) | 0;
      if (drawStart < 0) drawStart = 0;
      if (drawEnd >= render.h) drawEnd = render.h - 1;

      // Simple shading: darker on Y-side hits + distance fog.
      const sideShade = hit.side === 1 ? 0.72 : 1.0;
      const fog = 1 / (1 + dist * 0.12);
      const shade = sideShade * clamp(0.55 + fog, 0.35, 1.0);

      // Texture coordinate X (0..63), flipped depending on ray direction
      let texX = (hit.wallX * TEX_SIZE) | 0;
      if (hit.side === 0 && rayDirX > 0) texX = TEX_SIZE - texX - 1;
      if (hit.side === 1 && rayDirY < 0) texX = TEX_SIZE - texX - 1;

      const tex = wallTextures[hit.wallId] || wallTextures[1];
      const texData = tex.data;

      // Draw column by sampling texture per y.
      for (let y = drawStart; y <= drawEnd; y++) {
        // texY uses "step" across the slice height
        const d = y * 256 - render.h * 128 + lineH * 128;
        const texY = ((d * TEX_SIZE) / lineH / 256) | 0;
        const idx = (texY * TEX_SIZE + texX) * 4;
        let r = texData[idx];
        let g = texData[idx + 1];
        let b = texData[idx + 2];

        r = (r * shade) | 0;
        g = (g * shade) | 0;
        b = (b * shade) | 0;
        bctx.fillStyle = `rgb(${r},${g},${b})`;
        bctx.fillRect(x, y, 1, 1);
      }
    }
  }

  function drawSprites(dt) {
    // Build a single sprite list (decorations + enemies + portal + bullets) and draw back-to-front.
    const list = [];

    // Decorations (non-blocking detail)
    for (const d of LEVEL.decorations) {
      const dx = d.x - player.x;
      const dy = d.y - player.y;
      list.push({ kind: "deco", x: d.x, y: d.y, dist2: dx * dx + dy * dy, decoType: d.type });
    }

    // Enemies
    for (const e of enemies) {
      if (!e.alive) continue;
      const dx = e.x - player.x;
      const dy = e.y - player.y;
      list.push({ kind: "enemy", x: e.x, y: e.y, dist2: dx * dx + dy * dy, enemy: e });
    }

    // Portal
    {
      const p = LEVEL.portal;
      const dx = p.x - player.x;
      const dy = p.y - player.y;
      list.push({ kind: "portal", x: p.x, y: p.y, dist2: dx * dx + dy * dy });
    }

    // Bullets
    for (const b of bullets) {
      const dx = b.x - player.x;
      const dy = b.y - player.y;
      list.push({ kind: "bullet", x: b.x, y: b.y, dist2: dx * dx + dy * dy, bullet: b });
    }

    list.sort((a, b) => b.dist2 - a.dist2);

    for (const s of list) {
      if (s.kind === "enemy") {
        const e = s.enemy;
        e.animT += dt;
        const type = ENEMY_TYPES[e.typeKey] || ENEMY_TYPES.grunt;
        const frame = ((e.animT * 6) | 0) % type.frames.length;
        drawBillboardCanvas(type.frames[frame], e.x, e.y, type.scale, type.yOffset || 0);
      } else if (s.kind === "deco") {
        const spr = DECO_SPRITES[s.decoType];
        if (spr) drawBillboardCanvas(spr, s.x, s.y, 0.9, 0);
      } else if (s.kind === "portal") {
        drawPortalSprite();
      } else {
        // bullet
        drawBulletSprite(s.bullet);
      }
    }
  }

  function drawBillboardCanvas(spriteCanvas, worldX, worldY, scale, yOffset) {
    // Classic sprite rendering: project sprite into screen space and draw it as 1px vertical slices.
    const invDet = 1.0 / (player.planeX * player.dirY - player.dirX * player.planeY);
    const spriteX = worldX - player.x;
    const spriteY = worldY - player.y;

    const transformX = invDet * (player.dirY * spriteX - player.dirX * spriteY);
    const transformY = invDet * (-player.planeY * spriteX + player.planeX * spriteY);
    if (transformY <= 0.02) return;

    const screenX = ((render.w / 2) * (1 + transformX / transformY)) | 0;
    const spriteH = Math.abs(((render.h / transformY) * scale) | 0);
    const spriteW = spriteH;

    let drawStartY = ((-spriteH / 2 + render.h / 2) + (yOffset * render.h)) | 0;
    let drawEndY = ((spriteH / 2 + render.h / 2) + (yOffset * render.h)) | 0;
    let drawStartX = (-spriteW / 2 + screenX) | 0;
    let drawEndX = (spriteW / 2 + screenX) | 0;

    if (drawStartY < 0) drawStartY = 0;
    if (drawEndY >= render.h) drawEndY = render.h - 1;

    const texW = spriteCanvas.width;
    const texH = spriteCanvas.height;

    for (let stripe = drawStartX; stripe <= drawEndX; stripe++) {
      if (stripe < 0 || stripe >= render.w) continue;
      if (transformY >= zBuffer[stripe]) continue;

      const texX = (((stripe - drawStartX) * texW) / Math.max(1, (drawEndX - drawStartX))) | 0;
      // Draw 1px column slice from the sprite texture
      bctx.drawImage(spriteCanvas, texX, 0, 1, texH, stripe, drawStartY, 1, drawEndY - drawStartY + 1);
    }
  }

  function drawPortalSprite() {
    const p = LEVEL.portal;

    const invDet = 1.0 / (player.planeX * player.dirY - player.dirX * player.planeY);
    const spriteX = p.x - player.x;
    const spriteY = p.y - player.y;

    const transformX = invDet * (player.dirY * spriteX - player.dirX * spriteY);
    const transformY = invDet * (-player.planeY * spriteX + player.planeX * spriteY);
    if (transformY <= 0.02) return;

    const screenX = ((render.w / 2) * (1 + transformX / transformY)) | 0;
    const spriteH = Math.abs((render.h / transformY) | 0);
    const spriteW = spriteH;

    let drawStartY = (-spriteH / 2 + render.h / 2) | 0;
    let drawEndY = (spriteH / 2 + render.h / 2) | 0;
    let drawStartX = (-spriteW / 2 + screenX) | 0;
    let drawEndX = (spriteW / 2 + screenX) | 0;

    if (drawStartY < 0) drawStartY = 0;
    if (drawEndY >= render.h) drawEndY = render.h - 1;

    const locked = !!LEVEL.portalLocked;
    for (let x = drawStartX; x <= drawEndX; x++) {
      if (x < 0 || x >= render.w) continue;
      if (transformY >= zBuffer[x]) continue;

      const u = (x - drawStartX) / Math.max(1, drawEndX - drawStartX);
      const pulse = 0.55 + 0.45 * Math.sin(performance.now() * 0.008 + u * 6.283);
      const base = p.rgb || [190, 120, 255];
      const lockMul = locked ? 0.45 : 1.0;
      const r = (base[0] * (0.7 + 0.35 * pulse) * lockMul) | 0;
      const g = (base[1] * (0.7 + 0.35 * pulse) * lockMul) | 0;
      const b = (base[2] * (0.7 + 0.35 * pulse) * lockMul) | 0;
      bctx.fillStyle = `rgb(${r},${g},${b})`;

      // A "portal" look: central bright band + darker edges.
      const edge = Math.abs(u - 0.5) * 2;
      const innerStart = drawStartY + (spriteH * (0.08 + edge * 0.08)) | 0;
      const innerEnd = drawEndY - (spriteH * (0.08 + edge * 0.08)) | 0;
      bctx.fillRect(x, innerStart, 1, innerEnd - innerStart + 1);
    }
  }

  function drawBulletSprite(b) {
    const invDet = 1.0 / (player.planeX * player.dirY - player.dirX * player.planeY);
    const spriteX = b.x - player.x;
    const spriteY = b.y - player.y;

    const transformX = invDet * (player.dirY * spriteX - player.dirX * spriteY);
    const transformY = invDet * (-player.planeY * spriteX + player.planeX * spriteY);
    if (transformY <= 0.02) return;

    const screenX = ((render.w / 2) * (1 + transformX / transformY)) | 0;
    const size = clamp((render.h / transformY) * 0.06, 1.5, 10);
    const centerY = (render.h / 2) | 0;

    if (screenX < 0 || screenX >= render.w) return;
    if (transformY >= zBuffer[clamp(screenX | 0, 0, render.w - 1)]) return;

    const x0 = (screenX - size / 2) | 0;
    const y0 = (centerY - size / 2) | 0;
    const rgb = b.rgb || [255, 220, 120];
    bctx.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.95)`;
    bctx.fillRect(x0, y0, size, size);
  }

  // ---------- HUD / overlays ----------
  function setOverlayVisible(visible) {
    overlay.style.display = visible ? "grid" : "none";
  }

  function setPaused(nextPaused) {
    paused = nextPaused;
    if (paused) {
      setOverlayVisible(true);
      resumeBtn.hidden = false;
      startBtn.hidden = true;
    } else {
      setOverlayVisible(false);
      resumeBtn.hidden = true;
      startBtn.hidden = true;
    }
  }

  // ---------- Movement / collision ----------
  function canOccupy(x, y) {
    const r = player.radius;
    // Check 4 corners of the player's collision circle (approx via AABB around circle)
    return (
      !isWall(Math.floor(x - r), Math.floor(y - r)) &&
      !isWall(Math.floor(x + r), Math.floor(y - r)) &&
      !isWall(Math.floor(x - r), Math.floor(y + r)) &&
      !isWall(Math.floor(x + r), Math.floor(y + r))
    );
  }

  function canOccupyCircle(x, y, r) {
    return (
      !isWall(Math.floor(x - r), Math.floor(y - r)) &&
      !isWall(Math.floor(x + r), Math.floor(y - r)) &&
      !isWall(Math.floor(x - r), Math.floor(y + r)) &&
      !isWall(Math.floor(x + r), Math.floor(y + r))
    );
  }

  function tryMove(nx, ny) {
    // Slide along walls by resolving per-axis.
    if (canOccupy(nx, player.y)) player.x = nx;
    if (canOccupy(player.x, ny)) player.y = ny;
  }

  function rotatePlayer(angleRad) {
    // Rotate direction vector
    const oldDirX = player.dirX;
    player.dirX = player.dirX * Math.cos(angleRad) - player.dirY * Math.sin(angleRad);
    player.dirY = oldDirX * Math.sin(angleRad) + player.dirY * Math.cos(angleRad);

    // Rotate camera plane
    const oldPlaneX = player.planeX;
    player.planeX = player.planeX * Math.cos(angleRad) - player.planeY * Math.sin(angleRad);
    player.planeY = oldPlaneX * Math.sin(angleRad) + player.planeY * Math.cos(angleRad);
  }

  function update(dt) {
    // Movement speed (scaled by dt)
    const baseMove = 3.2; // units/s
    const baseStrafe = 3.0;
    const sprint = codesDown.has("ShiftLeft") || codesDown.has("ShiftRight") ? 1.35 : 1.0;
    const moveSpeed = baseMove * sprint * dt;
    const strafeSpeed = baseStrafe * dt;

    let vx = 0;
    let vy = 0;

    // Support common bindings across layouts:
    // - Physical WASD by `code` (works on any keyboard layout)
    // - Arrow keys
    // - AZERTY-friendly ZQSD (physical positions)
    // `key` fallback is latin-only; `code` is the primary path.
    if (isDown(["KeyW", "ArrowUp", "KeyZ"], ["w", "z"])) {
      vx += player.dirX * moveSpeed;
      vy += player.dirY * moveSpeed;
    }
    if (isDown(["KeyS", "ArrowDown"], ["s"])) {
      vx -= player.dirX * moveSpeed;
      vy -= player.dirY * moveSpeed;
    }
    // Strafe: perpendicular to direction
    const rightX = player.dirY;
    const rightY = -player.dirX;
    if (isDown(["KeyD", "ArrowRight"], ["d"])) {
      vx += rightX * strafeSpeed;
      vy += rightY * strafeSpeed;
    }
    if (isDown(["KeyA", "ArrowLeft", "KeyQ"], ["a", "q"])) {
      vx -= rightX * strafeSpeed;
      vy -= rightY * strafeSpeed;
    }

    if (vx !== 0 || vy !== 0) tryMove(player.x + vx, player.y + vy);

    // Weapon bobbing is driven by intended movement (even if blocked slightly).
    const moveMag = Math.min(1, Math.hypot(vx, vy) / (baseMove * dt + 1e-6));
    weapon.bobAmt = lerp(weapon.bobAmt, moveMag, 0.18);
    weapon.bobT += dt * (4 + weapon.bobAmt * 6);
    weapon.recoilT = Math.max(0, weapon.recoilT - dt);
    weapon.flashT = Math.max(0, weapon.flashT - dt);

    // Update enemies / projectiles / portal
    updateEnemies(dt);
    updateBullets(dt);
    updateDoorsAndLocks();
    checkPortal();

    // HUD
    hpEl.textContent = String(Math.max(0, player.hp | 0));
    ammoEl.textContent = String(player.ammo | 0);
    if (levelEl) levelEl.textContent = String(LEVEL.index + 1);
    if (moneyEl) moneyEl.textContent = String(player.money | 0);

    if (player.hp <= 0) {
      player.hp = 0;
      setPaused(true);
      startBtn.hidden = false;
      resumeBtn.hidden = true;
      overlay.querySelector("p").innerHTML =
        "Ти загинув. Натисни <b>Start</b>, щоб перезапустити (HP/AMMO відновляться).";
    }
  }

  function updateEnemies(dt) {
    for (const e of enemies) {
      if (!e.alive) continue;
      const type = ENEMY_TYPES[e.typeKey] || ENEMY_TYPES.grunt;

      const dx = player.x - e.x;
      const dy = player.y - e.y;
      const dist = Math.hypot(dx, dy);

      // Basic chase if close enough
      if (dist < 9.5) {
        const speed = type.speed;
        const step = (speed * dt) / Math.max(0.0001, dist);
        const nx = e.x + dx * step;
        const ny = e.y + dy * step;

        // Keep enemy out of walls using radius collision, slide per-axis.
        if (canOccupyCircle(nx, e.y, e.radius)) e.x = nx;
        if (canOccupyCircle(e.x, ny, e.radius)) e.y = ny;
      }

      // Attack if very close (cooldown)
      e.cooldown = Math.max(0, e.cooldown - dt);
      if (dist < 0.75 && e.cooldown <= 0) {
        e.cooldown = 0.7;
        player.hp -= type.meleeDamage;
      }

      // Ranged attack: shoot at the player if we can "see" them (line of sight).
      e.shootCooldown = Math.max(0, e.shootCooldown - dt);
      if (dist < type.shootRange && dist > 0.9 && e.shootCooldown <= 0 && hasLineOfSight(e.x, e.y, player.x, player.y)) {
        e.shootCooldown = randRange(type.shootCooldown[0], type.shootCooldown[1]);
        spawnEnemyBullet(e.x, e.y, player.x, player.y, type.bullet);
      }
    }
  }

  function killEnemy(e) {
    if (!e.alive) return;
    e.alive = false;

    const type = ENEMY_TYPES[e.typeKey] || ENEMY_TYPES.grunt;
    player.money += type.reward || 10;

    // Miniboss unlocks the portal on this level
    if (e.isMiniBoss) LEVEL.portalLocked = false;
  }

  function updateDoorsAndLocks() {
    // Open doors when all enemies tagged to that door are dead.
    for (const d of LEVEL.doors) {
      if (d.open) continue;
      const tag = `${d.x},${d.y}`;
      let anyAlive = false;
      for (const e of enemies) {
        if (!e.alive) continue;
        if (e.doorTag === tag) {
          anyAlive = true;
          break;
        }
      }
      if (!anyAlive) {
        d.open = true;
        // Door tile becomes empty space
        if (MAP[d.y] && MAP[d.y][d.x] === 8) MAP[d.y][d.x] = 0;
      }
    }

    // Portal stays locked until miniboss is dead.
    if (LEVEL.portalLocked) {
      // If the miniboss is gone, unlock
      let bossAlive = false;
      for (const e of enemies) {
        if (e.alive && e.isMiniBoss) {
          bossAlive = true;
          break;
        }
      }
      if (!bossAlive) LEVEL.portalLocked = false;
    }
  }

  function hasLineOfSight(x0, y0, x1, y1) {
    // Simple ray-march between two points; returns false if any wall cell blocks the segment.
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.0001) return true;

    const step = 0.06; // smaller -> more accurate, but more work
    const steps = Math.ceil(dist / step);
    const sx = dx / steps;
    const sy = dy / steps;

    let x = x0;
    let y = y0;
    for (let i = 0; i < steps; i++) {
      x += sx;
      y += sy;
      if (isWall(Math.floor(x), Math.floor(y))) return false;
    }
    return true;
  }

  function spawnEnemyBullet(x0, y0, x1, y1, bulletSpec) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    const nx = dx / Math.max(0.0001, dist);
    const ny = dy / Math.max(0.0001, dist);
    const b = bulletSpec || { speed: 5.2, damage: 6, rgb: [255, 220, 120] };
    bullets.push({
      x: x0,
      y: y0,
      vx: nx * b.speed,
      vy: ny * b.speed,
      r: 0.07,
      life: 2.2,
      damage: b.damage,
      rgb: b.rgb,
    });
  }

  function updateBullets(dt) {
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      b.life -= dt;
      if (b.life <= 0) {
        bullets.splice(i, 1);
        continue;
      }

      const nx = b.x + b.vx * dt;
      const ny = b.y + b.vy * dt;

      // Wall hit
      if (isWall(Math.floor(nx), Math.floor(ny))) {
        bullets.splice(i, 1);
        continue;
      }

      b.x = nx;
      b.y = ny;

      // Player hit
      const dx = b.x - player.x;
      const dy = b.y - player.y;
      if (dx * dx + dy * dy < (b.r + player.radius) * (b.r + player.radius)) {
        player.hp -= b.damage || 6;
        bullets.splice(i, 1);
      }
    }
  }

  function checkPortal() {
    const p = LEVEL.portal;
    const dx = player.x - p.x;
    const dy = player.y - p.y;
    if (dx * dx + dy * dy > 0.28 * 0.28) return;
    if (LEVEL.portalLocked) return;

    if (levelIndex < LEVEL_COUNT - 1) {
      loadLevel(levelIndex + 1);
    } else {
      // Finished game
      setPaused(true);
      startBtn.hidden = false;
      resumeBtn.hidden = true;
      overlay.querySelector("p").innerHTML =
        "Перемога! Ти пройшов 2 рівні. Натисни <b>Start</b>, щоб почати знову.";
    }
  }

  function loadLevel(nextIndex) {
    levelIndex = nextIndex;
    LEVEL = buildLevel(levelIndex);
    MAP = LEVEL.map;
    MAP_W = MAP[0].length;
    MAP_H = MAP.length;

    // Reset player position to level start
    player.x = LEVEL.start.x;
    player.y = LEVEL.start.y;
    player.dirX = 1;
    player.dirY = 0;
    player.planeX = 0;
    player.planeY = 0.66;

    // Reset enemies and bullets for the level
    enemies.length = 0;
    enemies.push(...spawnEnemies());
    bullets.length = 0;
  }

  // ---------- Shooting ----------
  function shoot() {
    if (paused) return;
    if (player.ammo <= 0) return;
    player.ammo -= 1;
    playShotSound();
    weapon.recoilT = 0.12;
    weapon.flashT = 0.045;

    // Shoot along center view ray
    const rayDirX = player.dirX;
    const rayDirY = player.dirY;

    // Find wall distance along center ray (so enemies behind walls aren't hit)
    const wallHit = castRay(rayDirX, rayDirY);
    const wallDist = Math.max(0.0001, wallHit.perpWallDist);

    // Hit-test enemies: check angular alignment (like a simple hitscan) + distance + not behind wall.
    const maxRange = 10.5;
    const aimCos = Math.cos(4.5 * (Math.PI / 180)); // within ~4.5 degrees
    let best = null;
    let bestDist = Infinity;

    for (const e of enemies) {
      if (!e.alive) continue;
      const dx = e.x - player.x;
      const dy = e.y - player.y;
      const dist = Math.hypot(dx, dy);
      if (dist > maxRange) continue;
      if (dist > wallDist) continue; // behind wall along center ray
      const nx = dx / Math.max(0.0001, dist);
      const ny = dy / Math.max(0.0001, dist);
      const dot = nx * rayDirX + ny * rayDirY;
      if (dot < aimCos) continue;
      if (dist < bestDist) {
        bestDist = dist;
        best = e;
      }
    }

    if (best) {
      best.hp -= 22;
      if (best.hp <= 0) killEnemy(best);
    }
  }

  // ---------- Minimap ----------
  function drawMinimap() {
    const w = minimap.width;
    const h = minimap.height;
    mctx.clearRect(0, 0, w, h);

    // Background
    mctx.fillStyle = "rgba(0,0,0,0.35)";
    mctx.fillRect(0, 0, w, h);

    const pad = 10;
    const scale = Math.min((w - pad * 2) / MAP_W, (h - pad * 2) / MAP_H);

    // Walls
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        if (MAP[y][x] === 0) continue;
        mctx.fillStyle = MAP[y][x] === 8 ? "rgba(255, 210, 120, 0.28)" : "rgba(255,255,255,0.15)";
        mctx.fillRect(pad + x * scale, pad + y * scale, scale, scale);
      }
    }

    // Portal
    const prgb = (LEVEL.portal && LEVEL.portal.rgb) ? LEVEL.portal.rgb : [190, 120, 255];
    mctx.fillStyle = `rgba(${prgb[0]}, ${prgb[1]}, ${prgb[2]}, 0.95)`;
    mctx.fillRect(pad + LEVEL.portal.x * scale - 3, pad + LEVEL.portal.y * scale - 3, 6, 6);

    // Decorations
    mctx.fillStyle = "rgba(200, 200, 200, 0.35)";
    for (const d of LEVEL.decorations) {
      mctx.fillRect(pad + d.x * scale - 1, pad + d.y * scale - 1, 2, 2);
    }

    // Enemies
    for (const e of enemies) {
      if (!e.alive) continue;
      mctx.fillStyle = "rgba(255, 75, 75, 0.9)";
      mctx.beginPath();
      mctx.arc(pad + e.x * scale, pad + e.y * scale, 3.2, 0, Math.PI * 2);
      mctx.fill();
    }

    // Player
    mctx.fillStyle = "rgba(55, 255, 122, 0.95)";
    mctx.beginPath();
    mctx.arc(pad + player.x * scale, pad + player.y * scale, 3.5, 0, Math.PI * 2);
    mctx.fill();

    // Player view direction
    mctx.strokeStyle = "rgba(55, 255, 122, 0.95)";
    mctx.lineWidth = 2;
    mctx.beginPath();
    mctx.moveTo(pad + player.x * scale, pad + player.y * scale);
    mctx.lineTo(pad + (player.x + player.dirX * 0.9) * scale, pad + (player.y + player.dirY * 0.9) * scale);
    mctx.stroke();
  }

  // ---------- Final frame composition ----------
  function draw() {
    drawWorld();
    drawSprites(Math.max(0.0001, (performance.now() - lastT) / 1000));
    drawMinimap();

    // Present low-res buffer to fullscreen canvas
    fitCanvasToDisplaySize(canvas);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bufferCanvas, 0, 0, canvas.width, canvas.height);

    // Crosshair
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = Math.max(1, Math.floor(canvas.width / 600));
    ctx.beginPath();
    ctx.moveTo(-8, 0);
    ctx.lineTo(-3, 0);
    ctx.moveTo(8, 0);
    ctx.lineTo(3, 0);
    ctx.moveTo(0, -8);
    ctx.lineTo(0, -3);
    ctx.moveTo(0, 8);
    ctx.lineTo(0, 3);
    ctx.stroke();
    ctx.restore();

    // Weapon sprite (HUD) last
    drawWeapon();
  }

  function drawWeapon() {
    const w = canvas.width;
    const h = canvas.height;

    const baseScale = Math.max(1, Math.min(w / 960, h / 540));
    const spriteW = weapon.sprite.width * baseScale;
    const spriteH = weapon.sprite.height * baseScale;

    const bobX = Math.sin(weapon.bobT) * 10 * baseScale * weapon.bobAmt;
    const bobY = (Math.abs(Math.cos(weapon.bobT)) * 10 + Math.sin(weapon.bobT * 2) * 3) * baseScale * weapon.bobAmt;

    const recoilK = weapon.recoilT > 0 ? easeOutQuad(weapon.recoilT / 0.12) : 0;
    const recoilY = -18 * baseScale * recoilK;

    const x = (w / 2 - spriteW / 2 + bobX) | 0;
    const y = (h - spriteH + 18 * baseScale + bobY + recoilY) | 0;

    // Subtle shadow
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.filter = `blur(${Math.max(0, 3 * baseScale)}px)`;
    ctx.drawImage(weapon.sprite, x + 6 * baseScale, y + 10 * baseScale, spriteW, spriteH);
    ctx.restore();

    // Sprite
    ctx.drawImage(weapon.sprite, x, y, spriteW, spriteH);

    // Muzzle flash
    if (weapon.flashT > 0) {
      const fx = x + spriteW * 0.52;
      const fy = y + spriteH * 0.32;
      const fr = 26 * baseScale * (0.6 + (weapon.flashT / 0.045) * 0.6);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const grad = ctx.createRadialGradient(fx, fy, 2, fx, fy, fr);
      grad.addColorStop(0, "rgba(255,245,170,0.95)");
      grad.addColorStop(0.4, "rgba(255,160,60,0.65)");
      grad.addColorStop(1, "rgba(255,60,60,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(fx, fy, fr, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawPausedBackdrop() {
    // Render one world frame so background isn't blank.
    drawWorld();
    drawSprites(0);
    drawMinimap();
    fitCanvasToDisplaySize(canvas);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bufferCanvas, 0, 0, canvas.width, canvas.height);
  }

  function fitCanvasToDisplaySize(c) {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const w = (c.clientWidth * dpr) | 0;
    const h = (c.clientHeight * dpr) | 0;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
  }

  // ---------- Pointer lock ----------
  function requestLock() {
    canvas.requestPointerLock?.();
  }

  document.addEventListener("pointerlockchange", () => {
    pointerLocked = document.pointerLockElement === canvas;
    if (pointerLocked) {
      setPaused(false);
      window.addEventListener("mousemove", onMouseMove);
    } else {
      window.removeEventListener("mousemove", onMouseMove);
      if (!paused) setPaused(true);
    }
  });

  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (!pointerLocked) {
      requestLock();
      ensureAudio(); // user gesture -> unlock audio
      return;
    }
    shoot();
  });

  startBtn.addEventListener("click", () => {
    player.hp = 100;
    player.ammo = 50;
    player.money = 0;
    loadLevel(0);

    overlay.querySelector("p").innerHTML =
      "Натисни <b>ЛКМ</b>, щоб почати (ввімкнеться pointer lock). WASD — рух, миша — огляд, ЛКМ — постріл.";
    startBtn.hidden = true;
    resumeBtn.hidden = true;
    requestLock();
    ensureAudio();
  });

  resumeBtn.addEventListener("click", () => {
    requestLock();
    ensureAudio();
  });

  // ---------- Utilities ----------
  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function isDown(codes, keys) {
    for (const c of codes) if (codesDown.has(c)) return true;
    for (const k of keys) if (keysDown.has(k)) return true;
    return false;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function randRange(a, b) {
    return a + (b - a) * Math.random();
  }

  function easeOutQuad(t) {
    const u = clamp(t, 0, 1);
    return 1 - (1 - u) * (1 - u);
  }

  // ---------- Boot ----------
  // Initial draw
  loadLevel(0);
  drawPausedBackdrop();
  setOverlayVisible(true);
  startBtn.hidden = false;
  resumeBtn.hidden = true;
  rafId = requestAnimationFrame(tick);
})();
