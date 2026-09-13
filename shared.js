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
  // MOVEMENT CONSTANTS (arcade / Quake-style accelerate+friction model)
  // -----------------------------------------------------------------------
  // Every tunable movement number lives here. Nothing movement-related
  // should ever be a magic number elsewhere in the codebase.
  // =======================================================================
  const MOVEMENT = {
    walkSpeed: 6.2,
    sprintSpeed: 10.5,
    crouchSpeed: 3.2,

    acceleration: 70,       // ground acceleration
    airAcceleration: 25,    // air-strafe acceleration
    friction: 9,            // ground friction (deceleration)
    maxAirSpeed: 11,        // soft cap on horizontal air speed

    jumpVelocity: 9.2,
    gravity: 26,
    maxFallSpeed: 40,

    stepHeight: 0.55,       // auto step-up for stairs/small ledges

    playerRadius: 0.4,
    playerHeight: 1.8,
    crouchHeight: 1.1,

    eyeHeight: 1.62,
    crouchEyeHeight: 0.95,
  };

  const WORLD_BOUNDS = { minX: -75, maxX: 75, minY: -8, maxY: 60, minZ: -75, maxZ: 75 };

  // =======================================================================
  // WEAPON DEFINITIONS (data-driven — add new weapons here, nowhere else)
  // =======================================================================
  const WEAPONS = {
    rifle: {
      id: 'rifle',
      name: 'Assault Rifle',
      damage: 20,
      headshotMultiplier: 2.0,
      fireRateRpm: 600,          // rounds per minute
      magazineSize: 30,
      reserveAmmoMax: 120,
      reloadTimeMs: 1600,
      spreadBase: 0.010,         // radians, cone half-angle at rest
      spreadMax: 0.055,
      spreadPerShot: 0.006,
      spreadRecoveryPerSec: 0.22,
      range: 150,
      automatic: true,
      recoilKickPitch: 0.017,    // radians added to aim per shot
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
  // Small reusable helpers for constructing arenas out of primitives.
  // Both client (rendering) and server (collision) consume the exact same
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
   * step-up assist in the movement code to climb without jumping.
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

  function createSpawnPoint(list, x, y, z, yaw) {
    list.push({ x, y, z, yaw });
  }

  /**
   * Builds the default test arena. Returns { colliders, spawnPoints }.
   * `colliders` includes BOTH collidable and purely decorative geometry —
   * the client renders everything in this list; the server only tests
   * collision against entries where `collidable === true`.
   */
  function buildDefaultArena() {
    const geo = [];
    const spawns = [];

    // --- Floor -----------------------------------------------------------
    createBox(geo, { pos: { x: 0, y: -0.5, z: 0 }, size: { x: 140, y: 1, z: 140 }, color: 0x2b2f38, name: 'floor' });

    // --- Perimeter walls ---------------------------------------------------
    const wallH = 8, wallT = 2, half = 70;
    createWall(geo, { pos: { x: 0, y: wallH / 2, z: -half }, size: { x: 140 + wallT, y: wallH, z: wallT } });
    createWall(geo, { pos: { x: 0, y: wallH / 2, z: half }, size: { x: 140 + wallT, y: wallH, z: wallT } });
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
    const treeSpots = [[-60, 0], [60, 0], [0, -62], [0, 62], [-25, 55], [25, -55]];
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

    return { colliders: geo, spawnPoints: spawns };
  }

  // =======================================================================
  // COLLISION (AABB) — shared by movement simulation and server raycasts
  // =======================================================================
  function collidesAt(pos, radius, height, colliders) {
    for (let i = 0; i < colliders.length; i++) {
      const box = colliders[i];
      if (!box.collidable) continue;
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
  // MOVEMENT SIMULATION
  // -----------------------------------------------------------------------
  // simulateMovementStep() is the single source of truth for how a player
  // moves. The server calls it every tick with authoritative inputs; the
  // client calls it for local prediction and for replaying buffered inputs
  // during reconciliation. Given the same state+input+dt it always
  // produces the same result (deterministic, no randomness, no Date.now).
  // =======================================================================
  function applyFriction(vel, friction, dt) {
    const speed = Math.hypot(vel.x, vel.z);
    if (speed < 0.001) { vel.x = 0; vel.z = 0; return; }
    const drop = speed * friction * dt;
    const newSpeed = Math.max(0, speed - drop);
    const scale = newSpeed / speed;
    vel.x *= scale;
    vel.z *= scale;
  }

  function accelerate(vel, wishDir, wishSpeed, accel, dt) {
    const currentSpeed = vel.x * wishDir.x + vel.z * wishDir.z;
    const addSpeed = wishSpeed - currentSpeed;
    if (addSpeed <= 0) return;
    let accelSpeed = accel * dt * wishSpeed;
    if (accelSpeed > addSpeed) accelSpeed = addSpeed;
    vel.x += accelSpeed * wishDir.x;
    vel.z += accelSpeed * wishDir.z;
  }

  function moveAxisWithStep(state, axis, delta, colliders, radius, height) {
    if (Math.abs(delta) < 1e-9) return;
    const pos = state.position;
    const originalVal = pos[axis];

    pos[axis] += delta;
    if (!collidesAt(pos, radius, height, colliders)) return; // clear move

    // Try stepping up onto a small ledge/stair.
    const originalY = pos.y;
    pos.y += MOVEMENT.stepHeight;
    if (!collidesAt(pos, radius, height, colliders)) {
      return; // climbed the step; gravity will settle the player onto it
    }
    pos.y = originalY;

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
    const hit = collidesAt(pos, radius, height, colliders);
    if (hit) {
      if (dy <= 0) {
        pos.y = hit.max.y;
        state.grounded = true;
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
   * @param state  { position:{x,y,z}, velocity:{x,y,z}, grounded, crouching, sprinting }
   * @param input  { forward, back, left, right, jump, sprint, crouch, yaw }
   * @param dt     fixed timestep in seconds
   * @param colliders arena collider list
   * @returns { jumped, landed, landSpeed }
   */
  function simulateMovementStep(state, input, dt, colliders) {
    const events = { jumped: false, landed: false, landSpeed: 0 };
    const wasGrounded = state.grounded;

    state.crouching = !!input.crouch;
    state.sprinting = !!input.sprint && !state.crouching;

    const height = state.crouching ? MOVEMENT.crouchHeight : MOVEMENT.playerHeight;
    const radius = MOVEMENT.playerRadius;

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

    let targetSpeed = MOVEMENT.walkSpeed;
    if (state.crouching) targetSpeed = MOVEMENT.crouchSpeed;
    else if (state.sprinting) targetSpeed = MOVEMENT.sprintSpeed;

    if (state.grounded) {
      applyFriction(state.velocity, MOVEMENT.friction, dt);
      accelerate(state.velocity, { x: wishX, z: wishZ }, targetSpeed, MOVEMENT.acceleration, dt);
    } else {
      accelerate(state.velocity, { x: wishX, z: wishZ }, targetSpeed, MOVEMENT.airAcceleration, dt);
      const horizSpeed = Math.hypot(state.velocity.x, state.velocity.z);
      if (horizSpeed > MOVEMENT.maxAirSpeed) {
        const scale = MOVEMENT.maxAirSpeed / horizSpeed;
        state.velocity.x *= scale;
        state.velocity.z *= scale;
      }
    }

    if (input.jump && state.grounded) {
      state.velocity.y = MOVEMENT.jumpVelocity;
      state.grounded = false;
      events.jumped = true;
    }

    state.velocity.y -= MOVEMENT.gravity * dt;
    if (state.velocity.y < -MOVEMENT.maxFallSpeed) state.velocity.y = -MOVEMENT.maxFallSpeed;

    moveAxisWithStep(state, 'x', state.velocity.x * dt, colliders, radius, height);
    moveAxisWithStep(state, 'z', state.velocity.z * dt, colliders, radius, height);

    const fallSpeedBefore = state.velocity.y;
    moveVertical(state, state.velocity.y * dt, colliders, radius, height);

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
    createSpawnPoint,
    buildDefaultArena,
    collidesAt,
    rayIntersectsAABB,
    raycastWorld,
    raycastScene,
    getPlayerHitboxes,
    simulateMovementStep,
    createDefaultMovementState,
  };
});
