/**
 * shared.js
 * -----------------------------------------------------------------------
 * Code that MUST behave identically on the client (for local prediction)
 * and the server (for authoritative simulation). Keeping this in one file
 * that both sides load is what prevents client-prediction from ever
 * drifting out of sync with server authority.
 *
 * Loaded two ways:
 *   - Node (server.js):  const Shared = require('./shared.js');
 *   - Browser (index.html): <script src="/shared.js"></script>
 *                           then use the global `Shared` object.
 *
 * Everything in here is pure data + pure functions. No rendering,
 * no networking, no I/O.
 *
 * -----------------------------------------------------------------------
 * MOVEMENT PHILOSOPHY (read this before touching numbers)
 * -----------------------------------------------------------------------
 * The player should always be asking "how do I get from here to there"
 * rather than "I need to walk over there." Concretely that means:
 *   - Input is never buffered away — the state machine below reacts to
 *     an input the instant it's simulated, not on the next animation frame.
 *   - velocity is a first-class citizen. We never do `position += input`;
 *     everything is acceleration toward a desired velocity, so momentum is
 *     real and landing/turning never just zeroes it out.
 *   - Movement states LAYER instead of replacing each other. Sprinting,
 *     airborne, sliding and wallrunning are independent flags on the same
 *     state object (see MovementState below) rather than a single enum,
 *     so "sprinting + airborne + about to wallrun" is a normal frame, not
 *     a special case.
 * -----------------------------------------------------------------------
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod; // Node / CommonJS
  } else {
    root.Shared = mod; // Browser global
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // =======================================================================
  // NETWORK / MATCH CONFIG
  // =======================================================================
  const NET = {
    TICK_RATE: 60,              // authoritative simulation steps per second
    SNAPSHOT_RATE: 20,          // world-state broadcasts per second
    INTERP_DELAY_MS: 100,       // render remote players this far in the past
    MAX_PLAYERS: 16,
    RESPAWN_TIME_MS: 3000,
    SPAWN_PROTECTION_MS: 1500,
    MAX_HEALTH: 100,
  };
  NET.TICK_DT = 1 / NET.TICK_RATE;

  // =======================================================================
  // MOVEMENT CONSTANTS
  // -----------------------------------------------------------------------
  // Every tunable movement number lives here — nothing movement-related is
  // ever a magic number elsewhere. Grouped by the system that owns it so
  // it reads like a spec sheet, not a wall of numbers.
  // =======================================================================
  const MOVEMENT = {
    // ---- collision sizes ----
    playerRadius: 0.4,
    playerHeight: 1.8,
    crouchHeight: 1.1,       // also used while sliding
    eyeHeight: 1.62,
    crouchEyeHeight: 0.95,
    slideEyeHeight: 0.78,

    // ---- ground movement ----
    walkSpeed: 6.2,
    sprintSpeed: 10.8,
    crouchSpeed: 3.2,
    groundAcceleration: 65,
    groundDeceleration: 55,     // how hard we brake when there's no input
    turnAcceleration: 130,      // extra punch applied when reversing direction
    sprintAccelMultiplier: 1.2,

    // ---- air movement ----
    airAcceleration: 34,        // classic Quake accelerate() bends the velocity
    airControl: 1.0,            // multiplier on airAcceleration; tune independently

    // ---- jump & gravity ----
    jumpVelocity: 9.6,
    gravityUp: 24,               // lighter gravity on the way up...
    gravityDown: 32,              // ...heavier coming down = snappy, decisive arcs
    jumpCutMultiplier: 0.45,     // releasing jump early shortens the arc
    coyoteTime: 0.11,            // grace period to jump after walking off a ledge
    jumpBufferTime: 0.13,        // grace period for a jump pressed just before landing
    maxFallSpeed: 45,

    // ---- momentum caps (safety ceilings, not gameplay limits) ----
    absoluteSpeedCap: 45,

    // ---- sliding ----
    slideTriggerSpeed: 4.0,      // must be moving at least this fast to start a slide
    slideBoostMultiplier: 1.25,  // instant speed kick on slide entry
    slideMaxSpeed: 16,
    slideFriction: 2.2,          // much gentler than ground deceleration -> slides far
    slideSteerAcceleration: 14,  // light steering while sliding; momentum still dominates
    slideDuration: 1.2,
    slideMinSpeed: 3.0,          // slide auto-ends once it slows below this

    // ---- wallrunning ----
    wallDetectionDistance: 0.85,
    wallrunMinSpeed: 3.5,
    wallrunSpeed: 10.5,
    wallrunAcceleration: 45,
    wallrunGravity: 3.5,         // heavily reduced gravity while attached to a wall
    wallrunMaxTime: 1.6,
    wallJumpCooldown: 0.35,      // prevents instantly re-sticking to the same wall

    // ---- wall jumping ----
    wallJumpUpVelocity: 8.8,
    wallJumpAwayVelocity: 6.8,
    wallJumpForwardRetention: 0.85,

    // ---- slopes ----
    slopeDownhillAccel: 8,       // gravity-along-surface effect; same term decelerates uphill

    // ---- terrain ----
    stepHeight: 0.55,
  };

  const WORLD_BOUNDS = { minX: -75, maxX: 75, minY: -8, maxY: 60, minZ: -75, maxZ: 260 };

  // =======================================================================
  // WEAPON DEFINITIONS (data-driven — add new weapons here, nowhere else)
  // =======================================================================
  const WEAPONS = {
    rifle: {
      id: 'rifle',
      name: 'Assault Rifle',
      damage: 20,
      headshotMultiplier: 2.0,
      fireRateRpm: 600,
      magazineSize: 30,
      reserveAmmoMax: 120,
      reloadTimeMs: 1600,
      spreadBase: 0.010,
      spreadMax: 0.055,
      spreadPerShot: 0.006,
      spreadRecoveryPerSec: 0.22,
      range: 150,
      automatic: true,
      recoilKickPitch: 0.017,
      recoilKickYaw: 0.009,
    },
  };
  const DEFAULT_WEAPON = 'rifle';

  function fireCooldownMs(weapon) {
    return 60000 / weapon.fireRateRpm;
  }

  // =======================================================================
  // MATH HELPERS
  // =======================================================================
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function lerpAngle(a, b, t) {
    let diff = (b - a) % (Math.PI * 2);
    if (diff > Math.PI) diff -= Math.PI * 2;
    if (diff < -Math.PI) diff += Math.PI * 2;
    return a + diff * t;
  }

  function randRange(a, b) { return a + Math.random() * (b - a); }

  // =======================================================================
  // LEVEL BUILDING API
  // -----------------------------------------------------------------------
  // Small reusable helpers for constructing arenas out of primitives. Both
  // client (rendering) and server (collision) consume the exact same
  // output, so there is never a mismatch between what you see and what
  // blocks you.
  // =======================================================================
  function makeBoxDef(opts) {
    const { pos, size, color = 0x888888, collidable = true, name = 'box' } = opts;
    return {
      type: 'box',
      name,
      color,
      collidable,
      pos: { x: pos.x, y: pos.y, z: pos.z },
      size: { x: size.x, y: size.y, z: size.z },
      min: { x: pos.x - size.x / 2, y: pos.y - size.y / 2, z: pos.z - size.z / 2 },
      max: { x: pos.x + size.x / 2, y: pos.y + size.y / 2, z: pos.z + size.z / 2 },
    };
  }

  function createBox(list, opts) {
    const def = makeBoxDef(opts);
    list.push(def);
    return def;
  }

  function createWall(list, opts) {
    return createBox(list, { name: 'wall', color: 0x3d4a5c, collidable: true, ...opts });
  }

  function createPlatform(list, opts) {
    return createBox(list, { name: 'platform', color: 0x2f6f6f, collidable: true, ...opts });
  }

  function createCover(list, opts) {
    return createBox(list, { name: 'cover', color: 0xd9772f, collidable: true, ...opts });
  }

  function createDecoration(list, opts) {
    return createBox(list, { name: 'decoration', collidable: false, color: 0x3c8f5c, ...opts });
  }

  /**
   * Generates a staircase (a "ramp" made of solid, walkable steps) rising
   * along +X or +Z from `base`. Each riser is small enough for the
   * step-up assist in the movement code to climb without jumping. Use
   * this for incidental level stairs; use createSlope() below when you
   * specifically want a true smooth incline (movement lab, speed tech).
   */
  function createRamp(list, opts) {
    const {
      base, width, height, depth, steps = 8,
      axis = 'z', color = 0x455266,
    } = opts;
    const stepRise = height / steps;
    const stepRun = depth / steps;
    for (let i = 0; i < steps; i++) {
      const riseTop = stepRise * (i + 1);
      const runCenter = stepRun * i + stepRun / 2;
      const boxHeight = riseTop;
      const boxY = base.y + boxHeight / 2;
      const pos = axis === 'z'
        ? { x: base.x, y: boxY, z: base.z + runCenter }
        : { x: base.x + runCenter, y: boxY, z: base.z };
      const size = axis === 'z'
        ? { x: width, y: boxHeight, z: stepRun + 0.02 }
        : { x: stepRun + 0.02, y: boxHeight, z: width };
      createBox(list, { pos, size, color, collidable: true, name: 'ramp' });
    }
  }

  /**
   * A TRUE inclined plane (not a staircase). Walking on it interpolates
   * height smoothly and — via getSlopeGroundHeight()/the movement step —
   * projects gravity along the surface, so downhill travel gains speed
   * and uphill travel loses it, matching a real slope rather than a ramp
   * built from steps.
   *
   * `start` is the LOW/near end of the incline at ground height. The
   * slope rises by `riseHeight` (negative for a descending slope) over
   * `length`, extending in +axis direction if sign=1, -axis if sign=-1.
   * `width` is the walkable footprint perpendicular to the incline axis.
   */
  function createSlope(list, opts) {
    const { start, axis, length, width, riseHeight, sign = 1, color = 0x455266 } = opts;
    const def = {
      type: 'slope',
      name: 'slope',
      collidable: true,
      color,
      axis, length, width, riseHeight, sign,
      start: { x: start.x, y: start.y, z: start.z },
    };
    // Bounding box for systems that don't need the analytic surface
    // (bullet raycasts just treat the whole volume as solid).
    const topOffset = Math.max(0, riseHeight);
    const botOffset = Math.min(0, riseHeight);
    if (axis === 'z') {
      const zA = start.z, zB = start.z + length * sign;
      def.min = { x: start.x - width / 2, y: start.y + botOffset - 0.1, z: Math.min(zA, zB) };
      def.max = { x: start.x + width / 2, y: start.y + topOffset + 0.1, z: Math.max(zA, zB) };
    } else {
      const xA = start.x, xB = start.x + length * sign;
      def.min = { x: Math.min(xA, xB), y: start.y + botOffset - 0.1, z: start.z - width / 2 };
      def.max = { x: Math.max(xA, xB), y: start.y + topOffset + 0.1, z: start.z + width / 2 };
    }
    list.push(def);
    return def;
  }

  function createConeMarker(list, opts) {
    const { pos, radius = 1, height = 2, color = 0xf1c40f, name = 'marker' } = opts;
    const def = {
      type: 'cone', name, color, collidable: false,
      pos: { x: pos.x, y: pos.y, z: pos.z }, radius, height,
      min: { x: pos.x - radius, y: pos.y - height / 2, z: pos.z - radius },
      max: { x: pos.x + radius, y: pos.y + height / 2, z: pos.z + radius },
    };
    list.push(def);
    return def;
  }

  function createSpawnPoint(list, x, y, z, yaw) {
    list.push({ x, y, z, yaw });
  }

  /**
   * Builds the default test arena: the deathmatch arena plus, through a
   * doorway in the north wall, a dedicated movement-testing lab (sprint
   * straightaway, jump gaps, a wallrun/walljump chaining gauntlet, a true
   * slope into a slide corridor, and a finish pad). Returns
   * { colliders, spawnPoints }.
   */
  function buildDefaultArena() {
    const geo = [];
    const spawns = [];

    // --- Floor -----------------------------------------------------------
    createBox(geo, { pos: { x: 0, y: -0.5, z: 0 }, size: { x: 140, y: 1, z: 140 }, color: 0x2b2f38, name: 'floor' });

    // --- Perimeter walls (north wall has a doorway to the movement lab) ---
    const wallH = 8, wallT = 2, half = 70;
    const doorWidth = 14;
    const segLen = (140 + wallT - doorWidth) / 2;
    createWall(geo, { pos: { x: -(doorWidth / 2 + segLen / 2), y: wallH / 2, z: half }, size: { x: segLen, y: wallH, z: wallT } });
    createWall(geo, { pos: { x: (doorWidth / 2 + segLen / 2), y: wallH / 2, z: half }, size: { x: segLen, y: wallH, z: wallT } });
    createWall(geo, { pos: { x: 0, y: wallH / 2, z: -half }, size: { x: 140 + wallT, y: wallH, z: wallT } });
    createWall(geo, { pos: { x: -half, y: wallH / 2, z: 0 }, size: { x: wallT, y: wallH, z: 140 + wallT } });
    createWall(geo, { pos: { x: half, y: wallH / 2, z: 0 }, size: { x: wallT, y: wallH, z: 140 + wallT } });

    // --- Central raised platform with ramps on two sides ------------------
    createPlatform(geo, { pos: { x: 0, y: 2, z: 0 }, size: { x: 20, y: 4, z: 20 }, color: 0x2f6f6f });
    createRamp(geo, { base: { x: 0, y: 0, z: -20 }, width: 6, height: 4, depth: 10, steps: 9, axis: 'z' });
    createRamp(geo, { base: { x: 0, y: 0, z: 10 }, width: 6, height: 4, depth: 10, steps: 9, axis: 'z' });

    // --- Corner towers (verticality + sniping angles) ----------------------
    const towerPositions = [
      { x: -55, z: -55 }, { x: 55, z: -55 }, { x: -55, z: 55 }, { x: 55, z: 55 },
    ];
    for (const t of towerPositions) {
      createPlatform(geo, { pos: { x: t.x, y: 4, z: t.z }, size: { x: 10, y: 8, z: 10 }, color: 0x4a4f66 });
      createRamp(geo, {
        base: { x: t.x - 3, y: 0, z: t.z + (t.z < 0 ? 5 : -15) },
        width: 4, height: 8, depth: 10, steps: 12, axis: 'z',
      });
    }

    // --- Elevated side platforms connected by nothing (jump gaps) --------
    createPlatform(geo, { pos: { x: -35, y: 3, z: 0 }, size: { x: 12, y: 1, z: 12 }, color: 0x2f6f6f });
    createPlatform(geo, { pos: { x: 35, y: 3, z: 0 }, size: { x: 12, y: 1, z: 12 }, color: 0x2f6f6f });
    createRamp(geo, { base: { x: -41, y: 0, z: -6 }, width: 5, height: 3, depth: 8, steps: 7, axis: 'x' });
    createRamp(geo, { base: { x: 36, y: 0, z: -6 }, width: 5, height: 3, depth: 8, steps: 7, axis: 'x' });

    // --- Scattered cover boxes ---------------------------------------------
    const coverSpots = [
      [-15, 10], [15, 10], [-25, -30], [25, -30], [-10, 30], [10, 30],
      [-45, 30], [45, 30], [-45, -30], [45, -30], [0, -45], [0, 45],
    ];
    for (const [x, z] of coverSpots) {
      const w = randRange(2.5, 4);
      const h = randRange(1.4, 2.6);
      createCover(geo, { pos: { x, y: h / 2, z }, size: { x: w, y: h, z: w } });
    }

    // --- Pillars in corridors (break sightlines) ---------------------------
    for (let i = -1; i <= 1; i += 2) {
      createCover(geo, { pos: { x: i * 8, y: 3, z: -55 }, size: { x: 2, y: 6, z: 2 }, color: 0x6a6f80 });
      createCover(geo, { pos: { x: i * 8, y: 3, z: 55 }, size: { x: 2, y: 6, z: 2 }, color: 0x6a6f80 });
    }

    // --- Decorative trees (trunk collidable, canopy decorative) ------------
    const treeSpots = [[-60, 0], [60, 0], [0, -62], [-25, 55], [25, -55]];
    for (const [x, z] of treeSpots) {
      createBox(geo, { pos: { x, y: 1.5, z }, size: { x: 0.8, y: 3, z: 0.8 }, color: 0x6b4a32, name: 'tree-trunk', collidable: true });
      createDecoration(geo, { pos: { x, y: 3.6, z }, size: { x: 2.4, y: 2.2, z: 2.4 }, color: 0x3c8f5c, name: 'tree-canopy' });
    }

    // --- Spawn points (ring around the arena, facing inward) --------------
    const spawnCount = 10;
    const ringRadius = 58;
    for (let i = 0; i < spawnCount; i++) {
      const a = (i / spawnCount) * Math.PI * 2;
      const x = Math.cos(a) * ringRadius;
      const z = Math.sin(a) * ringRadius;
      const yaw = Math.atan2(-x, -z); // face toward center (0,0)
      createSpawnPoint(spawns, x, 1.0, z, yaw);
    }

    buildMovementLab(geo);

    return { colliders: geo, spawnPoints: spawns };
  }

  /**
   * The movement laboratory: an intentionally ugly gauntlet through the
   * north doorway for testing sprint, jump distance, wallrunning,
   * wall-jump chaining, true slopes, and sliding in isolation. Not part
   * of the spawn rotation — you walk here on purpose.
   */
  function buildMovementLab(geo) {
    let z = 72; // just past the doorway gap in the north wall

    // Safety catch floor under the whole lab so a missed jump means a
    // short annoying walk back, not a soft-lock in the void. Kept well
    // below the lowest walkable surface (the slide corridor bottoms out
    // around y=-3.6) so a player's bounding box is never able to overlap
    // both surfaces at once.
    createBox(geo, { pos: { x: 0, y: -6, z: z + 90 }, size: { x: 30, y: 1, z: 220 }, color: 0x161a20, name: 'lab-safety-floor' });

    // --- Section 1: sprint straightaway (pure top-speed test) ------------
    const sprintLen = 40;
    createPlatform(geo, { pos: { x: 0, y: -0.5, z: z + sprintLen / 2 }, size: { x: 8, y: 1, z: sprintLen }, color: 0x2b3140 });
    createBox(geo, { pos: { x: -4.4, y: 0.6, z: z + sprintLen / 2 }, size: { x: 0.8, y: 1.2, z: sprintLen }, color: 0x394152, name: 'guard-rail' });
    createBox(geo, { pos: { x: 4.4, y: 0.6, z: z + sprintLen / 2 }, size: { x: 0.8, y: 1.2, z: sprintLen }, color: 0x394152, name: 'guard-rail' });
    z += sprintLen;

    // --- Section 2: jump gaps of increasing distance ----------------------
    const gapPlatformLen = 7;
    createPlatform(geo, { pos: { x: 0, y: 0, z: z + gapPlatformLen / 2 }, size: { x: 6, y: 1, z: gapPlatformLen }, color: 0xd9772f });
    z += gapPlatformLen;
    for (const gap of [4, 6, 8]) {
      z += gap; // empty space over the safety floor
      createPlatform(geo, { pos: { x: 0, y: 0, z: z + gapPlatformLen / 2 }, size: { x: 6, y: 1, z: gapPlatformLen }, color: 0xd9772f });
      z += gapPlatformLen;
    }

    // --- Section 3: wallrun -> walljump chaining gauntlet -----------------
    // 3m clear corridor: running down the exact centerline is just outside
    // wall-detection range, so the player has to actually lean toward a
    // wall to catch it — matching the "requires intent" rule.
    const half = 1.5, thick = 1.0, wallY = 2.0;
    const runLen = 16;
    createWall(geo, { pos: { x: -(half + thick / 2), y: wallY, z: z + runLen / 2 }, size: { x: thick, y: 10, z: runLen }, color: 0x35507a, name: 'wallrun-surface' });
    createWall(geo, { pos: { x: (half + thick / 2), y: wallY, z: z + runLen / 2 }, size: { x: thick, y: 10, z: runLen }, color: 0x35507a, name: 'wallrun-surface' });
    z += runLen;

    const segLen = 4, segGap = 2;
    for (let i = 0; i < 4; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      createWall(geo, {
        pos: { x: side * (half + thick / 2), y: wallY, z: z + segLen / 2 },
        size: { x: thick, y: 10, z: segLen }, color: 0x35507a, name: 'wallrun-surface',
      });
      z += segLen + segGap;
    }
    z -= segGap; // land right after the final segment, not in the last gap

    createPlatform(geo, { pos: { x: 0, y: 0, z: z + 4 }, size: { x: 8, y: 1, z: 8 }, color: 0x2f6f6f });
    z += 8;

    // --- Section 4: a TRUE slope (not stairs) into a slide corridor ------
    const slopeLength = 12, slopeDrop = 2.6;
    createSlope(geo, { start: { x: 0, y: 0, z }, axis: 'z', sign: 1, length: slopeLength, width: 8, riseHeight: -slopeDrop });
    z += slopeLength;

    const slideLen = 12;
    createPlatform(geo, { pos: { x: 0, y: -slopeDrop - 0.5, z: z + slideLen / 2 }, size: { x: 8, y: 1, z: slideLen }, color: 0x2b3140 });
    createBox(geo, { pos: { x: 0, y: -slopeDrop + 1.15, z: z + slideLen / 2 }, size: { x: 8, y: 0.3, z: slideLen }, color: 0x1c2028, name: 'low-ceiling' });
    z += slideLen;

    // --- Finish pad ---------------------------------------------------------
    createPlatform(geo, { pos: { x: 0, y: -slopeDrop, z: z + 6 }, size: { x: 12, y: 1, z: 12 }, color: 0x9b59b6 });
    createConeMarker(geo, { pos: { x: 0, y: -slopeDrop + 2.2, z: z + 6 }, radius: 1.1, height: 2.4, color: 0xf1c40f });
  }

  // =======================================================================
  // COLLISION (AABB) — shared by movement simulation and server raycasts
  // -----------------------------------------------------------------------
  // Slopes are handled analytically (see getSlopeGroundHeight) rather than
  // as solid AABBs, so movement collision explicitly skips them here.
  // =======================================================================
  function collidesAt(pos, radius, height, colliders) {
    for (let i = 0; i < colliders.length; i++) {
      const box = colliders[i];
      if (!box.collidable || box.type === 'slope') continue;
      if (
        pos.x + radius > box.min.x && pos.x - radius < box.max.x &&
        pos.y + height > box.min.y && pos.y < box.max.y &&
        pos.z + radius > box.min.z && pos.z - radius < box.max.z
      ) {
        return box;
      }
    }
    return null;
  }

  function rayIntersectsAABB(origin, dir, min, max) {
    let tmin = -Infinity, tmax = Infinity;
    const axes = ['x', 'y', 'z'];
    for (let i = 0; i < 3; i++) {
      const a = axes[i];
      const d = dir[a];
      if (Math.abs(d) < 1e-9) {
        if (origin[a] < min[a] || origin[a] > max[a]) return null;
      } else {
        let t1 = (min[a] - origin[a]) / d;
        let t2 = (max[a] - origin[a]) / d;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) return null;
      }
    }
    if (tmax < 0) return null;
    return tmin >= 0 ? tmin : tmax;
  }

  /**
   * Same slab test as rayIntersectsAABB but also returns the outward
   * surface normal of the face that was struck first. Used for wall
   * detection (wallrunning needs to know which way "away from the wall"
   * points). The normal sign is tied directly to which face (min=-1,
   * max=+1) produced the near intersection for each axis — deriving it
   * from the ray direction's sign instead is a classic off-by-swap trap.
   */
  function rayIntersectsAABBWithNormal(origin, dir, min, max) {
    let tmin = -Infinity, tmax = Infinity;
    let hitAxis = null, hitNormalSign = 1;
    const axes = ['x', 'y', 'z'];
    for (let i = 0; i < 3; i++) {
      const a = axes[i];
      const d = dir[a];
      if (Math.abs(d) < 1e-9) {
        if (origin[a] < min[a] || origin[a] > max[a]) return null;
        continue;
      }
      const tMinFace = (min[a] - origin[a]) / d;
      const tMaxFace = (max[a] - origin[a]) / d;
      let tNear, tFar, nearIsMinFace;
      if (tMinFace < tMaxFace) { tNear = tMinFace; tFar = tMaxFace; nearIsMinFace = true; }
      else { tNear = tMaxFace; tFar = tMinFace; nearIsMinFace = false; }
      if (tNear > tmin) { tmin = tNear; hitAxis = a; hitNormalSign = nearIsMinFace ? -1 : 1; }
      if (tFar < tmax) tmax = tFar;
      if (tmin > tmax) return null;
    }
    if (tmax < 0) return null;
    const t = tmin >= 0 ? tmin : tmax;
    const normal = { x: 0, y: 0, z: 0 };
    if (hitAxis) normal[hitAxis] = hitNormalSign;
    return { t, normal };
  }

  function raycastWorld(origin, dir, maxDist, colliders) {
    let closest = null;
    for (let i = 0; i < colliders.length; i++) {
      const box = colliders[i];
      if (!box.collidable) continue;
      const t = rayIntersectsAABB(origin, dir, box.min, box.max);
      if (t !== null && t <= maxDist && (closest === null || t < closest.distance)) {
        closest = { distance: t, box };
      }
    }
    return closest;
  }

  function getPlayerHitboxes(position, crouching) {
    const height = crouching ? MOVEMENT.crouchHeight : MOVEMENT.playerHeight;
    const radius = MOVEMENT.playerRadius;
    const headHeight = 0.32;
    return {
      body: {
        min: { x: position.x - radius, y: position.y, z: position.z - radius },
        max: { x: position.x + radius, y: position.y + height - headHeight, z: position.z + radius },
      },
      head: {
        min: { x: position.x - radius * 0.82, y: position.y + height - headHeight, z: position.z - radius * 0.82 },
        max: { x: position.x + radius * 0.82, y: position.y + height, z: position.z + radius * 0.82 },
      },
    };
  }

  /**
   * Casts a ray against world geometry AND live player hitboxes, returning
   * the single closest hit of any kind. This is the authoritative function
   * the server uses to validate every shot.
   */
  function raycastScene(origin, dir, maxDist, colliders, players, excludePlayerId) {
    let best = null;
    const worldHit = raycastWorld(origin, dir, maxDist, colliders);
    if (worldHit) best = { distance: worldHit.distance, kind: 'world' };

    for (const p of players) {
      if (p.id === excludePlayerId) continue;
      if (p.lifeState !== 'alive' && p.lifeState !== 'respawning') continue;
      const boxes = getPlayerHitboxes(p.position, p.crouching);
      for (const zone of ['head', 'body']) {
        const t = rayIntersectsAABB(origin, dir, boxes[zone].min, boxes[zone].max);
        if (t !== null && t <= maxDist && (best === null || t < best.distance)) {
          best = { distance: t, kind: zone, playerId: p.id };
        }
      }
    }
    return best;
  }

  // =======================================================================
  // WALL DETECTION (for wallrunning)
  // -----------------------------------------------------------------------
  // Casts two rays from roughly chest height, one to each side (relative
  // to facing yaw). Only surfaces tall enough to run on register, and only
  // the closer of the two sides is reported — the movement step decides
  // whether it's actually eligible to start/continue a wallrun.
  // =======================================================================
  function castWallRay(origin, dir, maxDist, colliders) {
    let best = null;
    for (let i = 0; i < colliders.length; i++) {
      const box = colliders[i];
      if (!box.collidable || box.type === 'slope' || !box.size || box.size.y < 1.3) continue;
      const res = rayIntersectsAABBWithNormal(origin, dir, box.min, box.max);
      if (res && res.t <= maxDist && res.t > 0.001 && (!best || res.t < best.t)) {
        best = { t: res.t, normal: { x: res.normal.x, z: res.normal.z } };
      }
    }
    return best;
  }

  function detectWall(pos, yaw, playerHeight, colliders) {
    const origin = { x: pos.x, y: pos.y + playerHeight * 0.55, z: pos.z };
    const maxDist = MOVEMENT.wallDetectionDistance + MOVEMENT.playerRadius;
    const rightVec = { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
    const leftVec = { x: -rightVec.x, y: 0, z: -rightVec.z };

    const rightHit = castWallRay(origin, rightVec, maxDist, colliders);
    const leftHit = castWallRay(origin, leftVec, maxDist, colliders);

    if (rightHit && (!leftHit || rightHit.t <= leftHit.t)) return { side: 'right', normal: rightHit.normal, distance: rightHit.t };
    if (leftHit) return { side: 'left', normal: leftHit.normal, distance: leftHit.t };
    return null;
  }

  /**
   * The direction to run along a wall: perpendicular to its (horizontal)
   * normal, oriented to continue whichever way the player is currently
   * moving so a wallrun feels like a continuation of your run, not a
   * coin-flip.
   */
  function wallTangent(normal, velocity) {
    let tangent = { x: -normal.z, z: normal.x };
    const dot = velocity.x * tangent.x + velocity.z * tangent.z;
    if (dot < 0) tangent = { x: -tangent.x, z: -tangent.z };
    return tangent;
  }

  // =======================================================================
  // SLOPES — analytic ground height + surface normal for createSlope()
  // =======================================================================
  function getSlopeGroundHeight(pos, radius, colliders) {
    let best = null;
    for (let i = 0; i < colliders.length; i++) {
      const slope = colliders[i];
      if (slope.type !== 'slope' || !slope.collidable) continue;
      const along = slope.axis === 'z' ? (pos.z - slope.start.z) * slope.sign : (pos.x - slope.start.x) * slope.sign;
      const perp = slope.axis === 'z' ? (pos.x - slope.start.x) : (pos.z - slope.start.z);
      if (along < -radius || along > slope.length + radius) continue;
      if (Math.abs(perp) > slope.width / 2 + radius) continue;
      const t = clamp(along / slope.length, 0, 1);
      const y = slope.start.y + t * slope.riseHeight;
      if (!best || y > best.y) best = { y, slope };
    }
    return best;
  }

  function slopeSurfaceNormal(slope) {
    const angle = Math.atan2(slope.riseHeight, slope.length);
    const s = Math.sin(angle), c = Math.cos(angle);
    return slope.axis === 'z'
      ? { x: 0, y: c, z: -s * slope.sign }
      : { x: -s * slope.sign, y: c, z: 0 };
  }

  // =======================================================================
  // MOVEMENT SIMULATION
  // -----------------------------------------------------------------------
  // simulateMovementStep() is the single source of truth for how a player
  // moves. The server calls it every tick with authoritative inputs; the
  // client calls it for local prediction and for replaying buffered inputs
  // during reconciliation. Given the same state+input+dt it always
  // produces the same result (deterministic, no Date.now/Math.random in
  // the core physics — the only randomness is cosmetic weapon spread,
  // which lives in server.js, not here).
  //
  // Pipeline (matches the layered-state philosophy at the top of the
  // file):
  //   timers -> crouch/slide state -> wish direction -> wall detection ->
  //   wallrun state -> jump/walljump -> horizontal accel model (branches
  //   on ground/air/slide/wallrun) -> gravity -> move & collide -> caps
  // =======================================================================
  function applyFriction(vel, decel, dt) {
    const speed = Math.hypot(vel.x, vel.z);
    if (speed < 0.001) { vel.x = 0; vel.z = 0; return; }
    const drop = speed * decel * dt;
    const newSpeed = Math.max(0, speed - drop);
    const scale = newSpeed / speed;
    vel.x *= scale;
    vel.z *= scale;
  }

  function accelerate(vel, wishDir, wishSpeed, accel, dt) {
    // Classic Quake-style accelerate: only ADDS speed toward wishDir up to
    // wishSpeed. It never subtracts existing momentum, which is exactly
    // why air-strafing/wallrun-exit/wall-jump momentum carries through
    // untouched — this one function is most of "momentum preservation."
    const currentSpeed = vel.x * wishDir.x + vel.z * wishDir.z;
    const addSpeed = wishSpeed - currentSpeed;
    if (addSpeed <= 0) return;
    let accelSpeed = accel * dt * wishSpeed;
    if (accelSpeed > addSpeed) accelSpeed = addSpeed;
    vel.x += accelSpeed * wishDir.x;
    vel.z += accelSpeed * wishDir.z;
  }

  /** Ground acceleration with an extra "turn" punch when reversing direction. */
  function groundAccelerate(vel, wishDir, wishSpeed, accel, turnAccel, dt) {
    const speedMag = Math.hypot(vel.x, vel.z);
    const alongWish = vel.x * wishDir.x + vel.z * wishDir.z;
    const opposing = speedMag > 0.5 && alongWish < speedMag * 0.3;
    accelerate(vel, wishDir, wishSpeed, opposing ? turnAccel : accel, dt);
  }

  function resolveGroundParams(state) {
    if (state.sprinting) {
      return {
        maxSpeed: MOVEMENT.sprintSpeed,
        acceleration: MOVEMENT.groundAcceleration * MOVEMENT.sprintAccelMultiplier,
        turnAcceleration: MOVEMENT.turnAcceleration * MOVEMENT.sprintAccelMultiplier,
      };
    }
    if (state.crouching) {
      return { maxSpeed: MOVEMENT.crouchSpeed, acceleration: MOVEMENT.groundAcceleration, turnAcceleration: MOVEMENT.turnAcceleration };
    }
    return { maxSpeed: MOVEMENT.walkSpeed, acceleration: MOVEMENT.groundAcceleration, turnAcceleration: MOVEMENT.turnAcceleration };
  }

  function moveAxisWithStep(state, axis, delta, colliders, radius, height) {
    if (Math.abs(delta) < 1e-9) return;
    const pos = state.position;
    const originalVal = pos[axis];

    pos[axis] += delta;
    if (!collidesAt(pos, radius, height, colliders)) return; // clear move

    // Try stepping up onto a small ledge/stair (skipped while wallrunning —
    // stepping mid-run onto the wall's own ledge would just cause jitter).
    if (!state.wallrunning) {
      const originalY = pos.y;
      pos.y += MOVEMENT.stepHeight;
      if (!collidesAt(pos, radius, height, colliders)) return; // climbed the step
      pos.y = originalY;
    }

    // Blocked outright — push back flush against the obstacle (slide).
    pos[axis] = originalVal + delta;
    const hit = collidesAt(pos, radius, height, colliders);
    if (hit) {
      pos[axis] = delta > 0 ? hit.min[axis] - radius - 0.001 : hit.max[axis] + radius + 0.001;
      state.velocity[axis] = 0;
    }
  }

  function moveVertical(state, dy, colliders, radius, height) {
    const pos = state.position;
    pos.y += dy;
    state.grounded = false;
    state.groundNormal = null;

    // Analytic slope ground check takes priority over box collision.
    if (state.velocity.y <= 0) {
      const slopeHit = getSlopeGroundHeight(pos, radius, colliders);
      if (slopeHit && pos.y <= slopeHit.y + MOVEMENT.stepHeight && pos.y >= slopeHit.y - 1.2) {
        pos.y = slopeHit.y;
        state.velocity.y = 0;
        state.grounded = true;
        state.groundNormal = slopeSurfaceNormal(slopeHit.slope);
        return;
      }
    }

    const hit = collidesAt(pos, radius, height, colliders);
    if (hit) {
      if (dy <= 0) {
        pos.y = hit.max.y;
        state.grounded = true;
        state.groundNormal = { x: 0, y: 1, z: 0 };
      } else {
        pos.y = hit.min.y - height;
      }
      state.velocity.y = 0;
    }

    if (pos.y < WORLD_BOUNDS.minY) {
      pos.y = WORLD_BOUNDS.minY;
      state.velocity.y = 0;
      state.grounded = true;
    }
  }

  /**
   * @param state MovementState (see createDefaultMovementState)
   * @param input { forward, back, left, right, jump, sprint, crouch, yaw }
   * @param dt    fixed timestep in seconds
   * @param colliders arena collider list
   * @returns { jumped, landed, landSpeed, walljumped, slideStarted }
   */
  function simulateMovementStep(state, input, dt, colliders) {
    const events = { jumped: false, landed: false, landSpeed: 0, walljumped: false, slideStarted: false };
    const wasGrounded = state.grounded;

    // ---- 1. timers ----------------------------------------------------
    if (state.wallJumpCooldownTimer > 0) state.wallJumpCooldownTimer = Math.max(0, state.wallJumpCooldownTimer - dt);
    state.timeSinceGrounded = state.grounded ? 0 : state.timeSinceGrounded + dt;

    const jumpPressedEdge = !!input.jump && !state.prevJumpHeld;
    state.jumpBufferTimer = jumpPressedEdge ? MOVEMENT.jumpBufferTime : Math.max(0, state.jumpBufferTimer - dt);
    state.prevJumpHeld = !!input.jump;

    // ---- 2. crouch / slide state machine -------------------------------
    const wantsCrouch = !!input.crouch;
    const horizSpeedNow = Math.hypot(state.velocity.x, state.velocity.z);

    if (!state.sliding && state.grounded && wantsCrouch && horizSpeedNow >= MOVEMENT.slideTriggerSpeed) {
      state.sliding = true;
      state.slideTimer = 0;
      const boosted = Math.min(horizSpeedNow * MOVEMENT.slideBoostMultiplier, MOVEMENT.slideMaxSpeed);
      const scale = horizSpeedNow > 0.001 ? boosted / horizSpeedNow : 0;
      state.velocity.x *= scale;
      state.velocity.z *= scale;
      events.slideStarted = true;
    }

    if (state.sliding) {
      state.slideTimer += dt;
      const speed = Math.hypot(state.velocity.x, state.velocity.z);
      const expired = state.slideTimer >= MOVEMENT.slideDuration || speed < MOVEMENT.slideMinSpeed;
      if (!state.grounded || !wantsCrouch || expired) state.sliding = false;
    }

    state.crouching = wantsCrouch || state.sliding;
    // Head-clearance check: only actually stand back up if there's room.
    if (!wantsCrouch && !state.sliding && collidesAt(state.position, MOVEMENT.playerRadius, MOVEMENT.playerHeight, colliders)) {
      state.crouching = true;
    }

    const height = state.crouching ? MOVEMENT.crouchHeight : MOVEMENT.playerHeight;
    const radius = MOVEMENT.playerRadius;

    // ---- 3. sprint flag (persists through the air on purpose) ----------
    state.sprinting = !!input.sprint && !state.crouching;

    // ---- 4. wish direction from yaw ------------------------------------
    const yaw = input.yaw || 0;
    const fwd = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
    const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    let wishX = 0, wishZ = 0;
    if (input.forward) { wishX += fwd.x; wishZ += fwd.z; }
    if (input.back) { wishX -= fwd.x; wishZ -= fwd.z; }
    if (input.right) { wishX += right.x; wishZ += right.z; }
    if (input.left) { wishX -= right.x; wishZ -= right.z; }
    const wishLen = Math.hypot(wishX, wishZ);
    if (wishLen > 0.0001) { wishX /= wishLen; wishZ /= wishLen; }
    const wishDir = { x: wishX, z: wishZ };

    // ---- 5. wall detection (airborne only) -----------------------------
    const wallInfo = (!state.grounded && !state.sliding)
      ? detectWall(state.position, yaw, height, colliders)
      : null;

    // ---- 6. wallrun state machine ---------------------------------------
    if (state.wallrunning) {
      const stillWalled = wallInfo && wallInfo.side === state.wallrunSide;
      const expired = state.wallrunTimer >= MOVEMENT.wallrunMaxTime;
      if (state.grounded || state.sliding || !stillWalled || !input.forward || expired) {
        state.wallrunning = false;
        state.wallrunSide = null;
        state.wallNormal = null;
      }
    }
    if (!state.wallrunning && wallInfo && !state.grounded && !state.sliding && input.forward
      && Math.hypot(state.velocity.x, state.velocity.z) >= MOVEMENT.wallrunMinSpeed
      && !(state.wallJumpCooldownTimer > 0 && state.wallJumpSide === wallInfo.side)) {
      state.wallrunning = true;
      state.wallrunSide = wallInfo.side;
      state.wallNormal = wallInfo.normal;
      state.wallrunTimer = 0;
    }
    if (state.wallrunning) state.wallrunTimer += dt;

    // ---- 7. jump / wall-jump resolution ---------------------------------
    const wantsJump = state.jumpBufferTimer > 0;
    if (state.wallrunning && wantsJump) {
      const n = state.wallNormal;
      const tangent = wallTangent(n, state.velocity);
      const alongSpeed = state.velocity.x * tangent.x + state.velocity.z * tangent.z;
      state.velocity.x = tangent.x * alongSpeed * MOVEMENT.wallJumpForwardRetention + n.x * MOVEMENT.wallJumpAwayVelocity;
      state.velocity.z = tangent.z * alongSpeed * MOVEMENT.wallJumpForwardRetention + n.z * MOVEMENT.wallJumpAwayVelocity;
      state.velocity.y = MOVEMENT.wallJumpUpVelocity;
      state.wallJumpSide = state.wallrunSide;
      state.wallJumpCooldownTimer = MOVEMENT.wallJumpCooldown;
      state.wallrunning = false;
      state.wallrunSide = null;
      state.wallNormal = null;
      state.jumpBufferTimer = 0;
      state.grounded = false;
      state.jumpHeldFromLastJump = true;
      events.jumped = true;
      events.walljumped = true;
    } else if (wantsJump && (state.grounded || state.timeSinceGrounded <= MOVEMENT.coyoteTime) && !state.jumpHeldFromLastJump) {
      state.velocity.y = MOVEMENT.jumpVelocity;
      state.grounded = false;
      state.sliding = false;
      state.jumpBufferTimer = 0;
      state.jumpHeldFromLastJump = true;
      events.jumped = true;
    }
    if (state.grounded) state.jumpHeldFromLastJump = false;

    // Variable jump height: releasing jump early while still rising cuts
    // the upward velocity short exactly once per jump.
    if (!input.jump && state.velocity.y > 0 && state.jumpHeldFromLastJump) {
      state.velocity.y *= MOVEMENT.jumpCutMultiplier;
      state.jumpHeldFromLastJump = false;
    }

    // ---- 8. horizontal acceleration model --------------------------------
    if (state.wallrunning) {
      const n = state.wallNormal;
      const tangent = wallTangent(n, state.velocity);
      const alongSpeed = state.velocity.x * tangent.x + state.velocity.z * tangent.z;
      state.velocity.x = tangent.x * alongSpeed;
      state.velocity.z = tangent.z * alongSpeed;
      accelerate(state.velocity, tangent, MOVEMENT.wallrunSpeed, MOVEMENT.wallrunAcceleration, dt);
    } else if (state.sliding) {
      applyFriction(state.velocity, MOVEMENT.slideFriction, dt);
      accelerate(state.velocity, wishDir, MOVEMENT.slideMaxSpeed, MOVEMENT.slideSteerAcceleration, dt);
    } else if (state.grounded) {
      // Slope contribution: gravity projected along the surface. The same
      // term accelerates you downhill and decelerates you uphill.
      if (state.groundNormal && state.groundNormal.y < 0.995) {
        const dx = state.groundNormal.x, dz = state.groundNormal.z;
        const len = Math.hypot(dx, dz);
        if (len > 0.0001) {
          const slopeFactor = 1 - state.groundNormal.y;
          const accel = MOVEMENT.slopeDownhillAccel * slopeFactor;
          state.velocity.x += (dx / len) * accel * dt;
          state.velocity.z += (dz / len) * accel * dt;
        }
      }
      const params = resolveGroundParams(state);
      applyFriction(state.velocity, MOVEMENT.groundDeceleration, dt);
      groundAccelerate(state.velocity, wishDir, params.maxSpeed, params.acceleration, params.turnAcceleration, dt);
    } else {
      const targetSpeed = state.sprinting ? MOVEMENT.sprintSpeed : MOVEMENT.walkSpeed;
      accelerate(state.velocity, wishDir, targetSpeed, MOVEMENT.airAcceleration * MOVEMENT.airControl, dt);
    }

    // ---- 9. gravity -------------------------------------------------------
    if (state.wallrunning) {
      state.velocity.y -= MOVEMENT.wallrunGravity * dt;
    } else {
      const g = state.velocity.y > 0 ? MOVEMENT.gravityUp : MOVEMENT.gravityDown;
      state.velocity.y -= g * dt;
    }
    if (state.velocity.y < -MOVEMENT.maxFallSpeed) state.velocity.y = -MOVEMENT.maxFallSpeed;

    // ---- 10. move + collide -----------------------------------------------
    moveAxisWithStep(state, 'x', state.velocity.x * dt, colliders, radius, height);
    moveAxisWithStep(state, 'z', state.velocity.z * dt, colliders, radius, height);

    const fallSpeedBefore = state.velocity.y;
    moveVertical(state, state.velocity.y * dt, colliders, radius, height);
    if (state.grounded) { state.wallrunning = false; state.wallrunSide = null; state.wallNormal = null; }

    // ---- 11. safety caps ----------------------------------------------------
    const speed3 = Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z);
    if (speed3 > MOVEMENT.absoluteSpeedCap) {
      const scale = MOVEMENT.absoluteSpeedCap / speed3;
      state.velocity.x *= scale; state.velocity.y *= scale; state.velocity.z *= scale;
    }
    state.position.x = clamp(state.position.x, WORLD_BOUNDS.minX, WORLD_BOUNDS.maxX);
    state.position.z = clamp(state.position.z, WORLD_BOUNDS.minZ, WORLD_BOUNDS.maxZ);

    if (!wasGrounded && state.grounded) {
      events.landed = true;
      events.landSpeed = Math.abs(fallSpeedBefore);
    }
    return events;
  }

  function createDefaultMovementState(pos) {
    return {
      position: { x: pos.x, y: pos.y, z: pos.z },
      velocity: { x: 0, y: 0, z: 0 },
      grounded: false,
      crouching: false,
      sprinting: false,
      sliding: false,
      wallrunning: false,
      wallrunSide: null,
      wallNormal: null,
      groundNormal: null,
      timeSinceGrounded: 999,
      jumpBufferTimer: 0,
      prevJumpHeld: false,
      jumpHeldFromLastJump: false,
      slideTimer: 0,
      wallrunTimer: 0,
      wallJumpCooldownTimer: 0,
      wallJumpSide: null,
    };
  }

  // =======================================================================
  // EXPORTS
  // =======================================================================
  return {
    NET,
    MOVEMENT,
    WORLD_BOUNDS,
    WEAPONS,
    DEFAULT_WEAPON,
    fireCooldownMs,
    clamp,
    lerp,
    lerpAngle,
    randRange,
    createBox,
    createWall,
    createPlatform,
    createCover,
    createDecoration,
    createRamp,
    createSlope,
    createConeMarker,
    createSpawnPoint,
    buildDefaultArena,
    collidesAt,
    rayIntersectsAABB,
    rayIntersectsAABBWithNormal,
    raycastWorld,
    raycastScene,
    getPlayerHitboxes,
    detectWall,
    wallTangent,
    getSlopeGroundHeight,
    slopeSurfaceNormal,
    simulateMovementStep,
    createDefaultMovementState,
  };
});
