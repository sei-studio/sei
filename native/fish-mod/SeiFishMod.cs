using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using UnityEngine;
using UnityEngine.SceneManagement;

// Sei plays FISH: this mod is the body, Sei is the brain.
//
// The bridge is file based because the mod sandbox refuses System.Net and
// System.IO. Sei writes cmd.txt, the mod writes state.txt, both through the
// approved LoadText/SaveText helpers in ModData\sei_fish.
//
// Locomotion goes through PlayerController.moveX/moveY. The game reads those
// from the Input System in GetInput() and turns them into AddForce in Move(),
// so writing rb.linearVelocity does nothing. The [ModPatch] after GetInput
// overwrites the two fields every frame, which is the one place that survives
// into FixedUpdate.
//
// FISH is 2D: y is height, not depth. A jump is a decision, never a steering
// axis, so moveY stays 0 and the body only ever hops upward.
public class SeiFishMod : ModBehaviour
{
    private const string STATE_FILE = "state.txt";
    private const string CMD_FILE = "cmd.txt";

    private const int STATE_EVERY_FRAMES = 6;
    private const int MAX_ENEMIES = 16;

    private const int JUMP_EVERY_FRAMES = 20;
    private const float HOP_DISTANCE = 10f;
    private const float ARRIVE_DISTANCE = 0.6f;

    // A wall is not a target: after this many frames without progress the body
    // tries a hop, and after STUCK_JUMPS hops it gives up and reports stuck.
    private const float STUCK_EPSILON = 0.05f;
    private const int STUCK_FRAMES = 20;
    private const int STUCK_JUMPS = 2;

    private const int WEAPON_CACHE_FRAMES = 15;
    private const int ERROR_LOG_EVERY_FRAMES = 300;

    // Intent. Static because the GetInput patch has no ModBehaviour instance.
    private static bool hasTarget;
    private static float targetX;
    private static float targetY;
    private static bool fire;
    private static bool attack;
    private static string aimName;
    private static float aimX;
    private static bool fell;
    private static bool stuck;
    private static int patchHits;
    private static int jumpedAt;
    private static bool wasGrounded;

    private int frame;
    private int lastJumpFrame;
    private string lastCmd;

    private int stuckFrames;
    private int stuckJumps;
    private float lastProgressX;

    private bool warnedShoot;
    private bool warnedJump;
    private bool warnedWeapon;
    private bool warnedAutoSwitch;
    private float lastShotAt;

    // Weapon resolution is a scene walk, so it is cached for a few frames.
    private GunController gun;
    private string gunLabel = "-";
    private string wcLabel = "-";
    private int weaponCount = -1;
    private int weaponIndex = -1;
    private bool melee;
    private int weaponResolvedAt = -9999;

    public override void OnModLoaded()
    {
        Log("sei: loaded");
    }

    public override void OnLevelStarted(string levelName)
    {
        ClearIntent();
        InvalidateWeapon();
        Log("sei: level " + levelName);
    }

    public override void OnPlayerSpawned(PlayerController fish)
    {
        InvalidateWeapon();
        Log("sei: player spawned");
    }

    public override void OnPlayerDied(PlayerController fish)
    {
        ClearIntent();
        InvalidateWeapon();
    }

    private static void ClearIntent()
    {
        hasTarget = false;
        fire = false;
        attack = false;
        aimName = null;
        fell = false;
        stuck = false;
    }

    private void InvalidateWeapon()
    {
        weaponResolvedAt = -9999;
        gun = null;
    }

    private void Update()
    {
        frame++;
        try
        {
            PlayerController fish = PlayerController.FindLivePlayer1();
            ReadCommands();
            // Cached, so the state stream always knows what is in hand even
            // when the body is not attacking.
            if (fish != null) ResolveWeapon(fish, false);
            TrackGround(fish);
            TrackProgress(fish);
        }
        catch (Exception e)
        {
            if (frame % ERROR_LOG_EVERY_FRAMES == 0) Log("sei: update error " + e.Message);
        }

        // The state stream must survive a broken body: its own guard, so one
        // failing read cannot silence the whole bridge.
        if (frame % STATE_EVERY_FRAMES == 0)
        {
            try
            {
                WriteState(PlayerController.FindLivePlayer1());
            }
            catch (Exception e)
            {
                if (frame % ERROR_LOG_EVERY_FRAMES == 0) Log("sei: state error " + e.Message);
            }
        }
    }

    private void LateUpdate()
    {
        if (!fire && !attack) return;
        try
        {
            PlayerController fish = PlayerController.FindLivePlayer1();
            if (fish == null) return;
            ResolveWeapon(fish, false);
            if (attack) Engage(fish);
            else Fire(fish);
        }
        catch (Exception e)
        {
            if (frame % ERROR_LOG_EVERY_FRAMES == 0) Log("sei: aim error " + e.Message);
        }
    }

    // Called from the GetInput patch, after the Input System wrote moveX.
    public static void InjectInput(PlayerController fish)
    {
        if (fish == null) return;
        patchHits++;
        if (!hasTarget) return;

        float dx = targetX - fish.transform.position.x;
        if (Mathf.Abs(dx) <= ARRIVE_DISTANCE)
        {
            hasTarget = false;
            fish.moveX = 0f;
            return;
        }

        fish.moveX = dx > 0f ? 1f : -1f;
        fish.isFacingRight = dx > 0f;
        // FISH is 2D: never steer vertically, height is reached by jumping.
        fish.moveY = 0f;
    }

    // Hops when the target sits above, and notices walking off a ledge.
    private void TrackGround(PlayerController fish)
    {
        bool grounded = fish != null && fish.groundCheck;

        if (fish != null && hasTarget && grounded)
        {
            float dy = targetY - fish.transform.position.y;
            if (dy > HOP_DISTANCE && frame - lastJumpFrame > JUMP_EVERY_FRAMES)
            {
                lastJumpFrame = frame;
                jumpedAt = frame;
                Jump(fish);
            }
        }

        // Losing the ground without a jump means we walked off a ledge.
        if (fish != null && wasGrounded && !grounded && frame - jumpedAt > 12)
        {
            fell = true;
            hasTarget = false;
        }

        wasGrounded = grounded;
    }

    // A wall looks exactly like slow walking: the intent is right, x does not
    // move. Hop over it, and if hopping twice does not help, say so.
    private void TrackProgress(PlayerController fish)
    {
        if (fish == null || !hasTarget)
        {
            stuckFrames = 0;
            stuckJumps = 0;
            return;
        }

        float x = fish.transform.position.x;
        if (Mathf.Abs(x - lastProgressX) < STUCK_EPSILON)
        {
            stuckFrames++;
        }
        else
        {
            stuckFrames = 0;
            stuckJumps = 0;
        }
        lastProgressX = x;

        if (stuckFrames < STUCK_FRAMES) return;
        stuckFrames = 0;

        // Count the attempt whether or not the fish is grounded: wedged in a
        // wall it often reports not grounded, and bailing out on that is what
        // made it grind against the wall forever.
        stuckJumps++;
        if (stuckJumps > STUCK_JUMPS)
        {
            stuck = true;
            hasTarget = false;
            return;
        }
        if (fish.groundCheck && frame - lastJumpFrame > JUMP_EVERY_FRAMES)
        {
            lastJumpFrame = frame;
            jumpedAt = frame;
            Jump(fish);
        }
    }

    private void ReadCommands()
    {
        string text = LoadText(CMD_FILE);
        if (text == null) return;
        text = text.Replace("\r\n", "\n").Replace('\r', '\n').Trim();
        if (text == lastCmd) return;
        lastCmd = text;

        string[] lines = text.Split('\n');
        for (int i = 0; i < lines.Length; i++)
        {
            string line = lines[i].Trim();
            if (line.Length == 0) continue;
            string[] parts = line.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0) continue;
            string verb = parts[0].ToLowerInvariant();

            if (verb == "goto" && parts.Length >= 3)
            {
                float x, y;
                if (!TryNum(parts[1], out x) || !TryNum(parts[2], out y)) continue;
                hasTarget = true;
                targetX = x;
                targetY = y;
                fell = false;
                stuck = false;
                stuckFrames = 0;
                stuckJumps = 0;
                lastProgressX = float.NaN;
                // A movement order supersedes a combat stance: otherwise the
                // old auto-attack keeps turning the fish toward the enemy.
                attack = false;
                fire = false;
                aimName = null;
            }
            else if (verb == "stop")
            {
                ClearIntent();
                stuckFrames = 0;
                stuckJumps = 0;
            }
            else if (verb == "shoot" && parts.Length >= 3)
            {
                float x, y;
                if (!TryNum(parts[1], out x) || !TryNum(parts[2], out y)) continue;
                aimX = x;
                fire = true;
            }
            else if (verb == "fire")
            {
                fire = parts.Length >= 2 && parts[1] == "1";
            }
            else if (verb == "attack")
            {
                attack = parts.Length >= 2 && parts[1] == "1";
                if (!attack) aimName = null;
            }
            else if (verb == "jump")
            {
                PlayerController fish = PlayerController.FindLivePlayer1();
                if (fish != null) Jump(fish);
            }
            else if (verb == "weapon" && parts.Length >= 2)
            {
                int index;
                if (int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out index))
                {
                    SwitchWeapon(index);
                }
            }
        }
    }

    private static bool TryNum(string s, out float value)
    {
        return float.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out value);
    }

    // Nearest living enemy, face it, hold the trigger.
    private void Engage(PlayerController fish)
    {
        Vector3 p = fish.transform.position;
        EnemyController best = null;
        float bestDist = float.MaxValue;
        List<EnemyController> living = EnemyController.Living();
        if (living != null)
        {
            for (int i = 0; i < living.Count; i++)
            {
                EnemyController e = living[i];
                if (e == null || e.healthPoints <= 0f) continue;
                float d = (e.transform.position - p).sqrMagnitude;
                if (d < bestDist)
                {
                    bestDist = d;
                    best = e;
                }
            }
        }

        if (best == null)
        {
            aimName = null;
            return;
        }

        Vector3 ep = best.transform.position;
        aimX = ep.x;
        aimName = best.GetType().Name;
        fish.isFacingRight = aimX >= p.x;
        Fire(fish);
    }

    private void Fire(PlayerController fish)
    {
        ResolveWeapon(fish, false);

        if (gun == null)
        {
            if (!warnedShoot)
            {
                warnedShoot = true;
                Log("sei: no weapon to fire (" + gunLabel + ")");
            }
            return;
        }

        // Melee weapons inherit GunController but override Shoot() with an empty
        // body, so the trigger does nothing. While attacking, take a ranged
        // weapon instead of silently standing there with a sword.
        if (melee)
        {
            if (attack && AutoSwitchToGun(fish))
            {
                ResolveWeapon(fish, true);
                if (gun == null || melee) return;
            }
            else
            {
                if (!warnedShoot)
                {
                    warnedShoot = true;
                    Log("sei: melee only (" + gunLabel + "), cannot shoot");
                }
                return;
            }
        }

        // Shoot() has no cooldown of its own: the game enforces it in GetInput(),
        // which we never run, so every weapon fired at frame rate. Respect the
        // weapon's own shootCooldown here or a shotgun outruns a minigun.
        float interval = Mathf.Max(gun.shootCooldown, 0.02f);
        if (Time.time - lastShotAt < interval) return;
        lastShotAt = Time.time;

        fish.isFacingRight = aimX >= fish.transform.position.x;
        // The game sets hasShotCheck from its own input path and Shoot() bails
        // out while it is false, so hold it open right before firing.
        gun.hasShotCheck = true;
        gun.Shoot();
    }

    private void ResolveWeapon(PlayerController fish, bool force)
    {
        if (!force && gun != null && frame - weaponResolvedAt < WEAPON_CACHE_FRAMES) return;
        weaponResolvedAt = frame;
        gun = null;
        gunLabel = "-";
        wcLabel = "-";
        weaponCount = -1;
        weaponIndex = -1;
        melee = false;

        WeaponController wc = WeaponController.FindFor(fish);
        if (wc == null)
        {
            gunLabel = "no-weapon";
            return;
        }

        GameObject held = null;
        try
        {
            List<GameObject> list = ModFields.Get<List<GameObject>>(wc, "equippedWeapons");
            weaponIndex = ModFields.Get<int>(wc, "currentWeaponIndex");
            if (list != null)
            {
                weaponCount = list.Count;
                // UpdateWeaponActiveStates leaves only the held weapon active,
                // so the hierarchy is the truth and the private index can be
                // stale. Trust what is actually on screen.
                for (int i = 0; i < list.Count; i++)
                {
                    if (list[i] != null && list[i].activeInHierarchy)
                    {
                        held = list[i];
                        weaponIndex = i;
                        break;
                    }
                }
                if (held == null && weaponIndex >= 0 && weaponIndex < list.Count) held = list[weaponIndex];
            }
        }
        catch (Exception)
        {
            // ModFields is best effort: the fallbacks below still find a gun.
        }
        wcLabel = "list" + weaponCount + ",idx" + weaponIndex;

        if (held != null)
        {
            gun = held.GetComponentInChildren<GunController>(true);
            if (gun != null) gunLabel = held.name + ":" + gun.GetType().Name;
            else gunLabel = held.name + ":none";
        }
        if (gun == null) gun = wc.GetComponentInChildren<GunController>(false);
        if (gun == null) gun = wc.GetComponentInChildren<GunController>(true);
        if (gun == null)
        {
            // Any gun in the scene owned by this fish. Melee weapons are
            // GunControllers too, so this covers sword and whip as well.
            GunController[] all = FindObjectsByType<GunController>(FindObjectsSortMode.None);
            for (int i = 0; i < all.Length; i++)
            {
                GunController g = all[i];
                if (g == null || g.player != fish || !g.isActiveAndEnabled) continue;
                gun = g;
                if (held == null) gunLabel = g.gameObject.name + ":" + g.GetType().Name;
                break;
            }
        }
        if (gun == null) gun = fish.GetComponentInChildren<GunController>(true);
        if (gun != null && gunLabel == "-") gunLabel = gun.GetType().Name;
        if (gun == null && gunLabel == "-") gunLabel = "no-gun";

        melee = gun is SwordController || gun is WhipController;
    }

    private void SwitchWeapon(int index)
    {
        PlayerController fish = PlayerController.FindLivePlayer1();
        if (fish == null) return;
        WeaponController wc = WeaponController.FindFor(fish);
        if (wc == null) return;
        try
        {
            List<GameObject> list = ModFields.Get<List<GameObject>>(wc, "equippedWeapons");
            if (list == null || index < 0 || index >= list.Count)
            {
                if (!warnedWeapon)
                {
                    warnedWeapon = true;
                    Log("sei: weapon " + index + " does not exist");
                }
                return;
            }
            wc.Hold(list[index]);
            InvalidateWeapon();
            Log("sei: holding weapon " + index + " (" + list[index].name + ")");
        }
        catch (Exception e)
        {
            if (!warnedWeapon)
            {
                warnedWeapon = true;
                Log("sei: weapon switch failed " + e.Message);
            }
        }
    }

    // Picks the first non-melee weapon in the fish's own list. A sword in hand
    // is never a reason to stop fighting.
    private bool AutoSwitchToGun(PlayerController fish)
    {
        WeaponController wc = WeaponController.FindFor(fish);
        if (wc == null) return false;
        try
        {
            List<GameObject> list = ModFields.Get<List<GameObject>>(wc, "equippedWeapons");
            if (list == null || list.Count == 0) return false;
            for (int i = 0; i < list.Count; i++)
            {
                // The held weapon is the active one; skip it and anything else
                // that is not a real ranged weapon.
                if (list[i] == null || list[i].activeInHierarchy) continue;
                GunController candidate = list[i].GetComponentInChildren<GunController>(true);
                if (candidate == null) continue;
                if (candidate is SwordController || candidate is WhipController) continue;
                wc.Hold(list[i]);
                InvalidateWeapon();
                if (!warnedAutoSwitch)
                {
                    warnedAutoSwitch = true;
                    Log("sei: took " + list[i].name + " for a gun");
                }
                return true;
            }
        }
        catch (Exception e)
        {
            if (!warnedAutoSwitch)
            {
                warnedAutoSwitch = true;
                Log("sei: auto switch failed " + e.Message);
            }
        }
        return false;
    }

    private void Jump(PlayerController fish)
    {
        try
        {
            fish.BlastJump();
            return;
        }
        catch (Exception)
        {
            // Fall through to the generic jump.
        }
        try
        {
            ModContent.Jump(fish, 8f);
        }
        catch (Exception e)
        {
            if (!warnedJump)
            {
                warnedJump = true;
                Log("sei: jump failed " + e.Message);
            }
        }
    }

    private void WriteState(PlayerController fish)
    {
        StringBuilder sb = new StringBuilder(1024);
        sb.Append("frame=").Append(frame);
        sb.Append(" level=").Append(Clean(SceneManager.GetActiveScene().name));
        sb.Append(" patch=").Append(patchHits);

        if (fish != null)
        {
            Vector3 p = fish.transform.position;
            Vector2 v = fish.rb != null ? fish.rb.linearVelocity : Vector2.zero;
            sb.Append(" x=").Append(F(p.x));
            sb.Append(" y=").Append(F(p.y));
            sb.Append(" vx=").Append(F(v.x));
            sb.Append(" vy=").Append(F(v.y));
            sb.Append(" hp=").Append(fish.healthPoints);
            sb.Append(" maxhp=").Append(fish.maxHealthPoints);
            sb.Append(" state=").Append(Clean(fish.currentState.ToString()));
            sb.Append(" facing=").Append(fish.isFacingRight ? 1 : 0);
            sb.Append(" grounded=").Append(fish.groundCheck ? 1 : 0);
            sb.Append(" fell=").Append(fell ? 1 : 0);
            sb.Append(" stuck=").Append(stuck ? 1 : 0);
            sb.Append(" attack=").Append(attack ? 1 : 0);
            sb.Append(" aim=").Append(Clean(aimName));
            sb.Append(" weapon=").Append(Clean(gunLabel));
            sb.Append(" melee=").Append(melee ? 1 : 0);
            sb.Append(" wc=").Append(Clean(wcLabel));
            sb.Append(" weapons=").Append(weaponCount);
            sb.Append(" held=").Append(weaponIndex);
            sb.Append(" movex=").Append(F(fish.moveX));
            sb.Append(" speed=").Append(F(fish.RunSpeed));
        }

        sb.Append(" money=").Append(TallyController.GetMoney());
        sb.Append(" kills=").Append(TallyController.GetKillCount());
        sb.Append('\n');

        int shown = 0;
        List<EnemyController> enemies = EnemyController.Living();
        if (enemies != null)
        {
            for (int i = 0; i < enemies.Count && shown < MAX_ENEMIES; i++)
            {
                EnemyController e = enemies[i];
                if (e == null) continue;
                Vector3 ep = e.transform.position;
                sb.Append("enemy type=").Append(Clean(e.GetType().Name));
                sb.Append(" x=").Append(F(ep.x));
                sb.Append(" y=").Append(F(ep.y));
                sb.Append(" hp=").Append(F(e.healthPoints));
                sb.Append('\n');
                shown++;
            }
        }

        SaveText(STATE_FILE, sb.ToString());
    }

    private static string F(float value)
    {
        return value.ToString("F2", CultureInfo.InvariantCulture);
    }

    private static string Clean(string text)
    {
        if (string.IsNullOrEmpty(text)) return "-";
        return text.Replace(' ', '_').Replace('\n', '_').Replace('\r', '_');
    }
}

// The one hook that can beat the Input System: GetInput() writes moveX/moveY
// from the controller, so overwrite them right after it returns and before
// FixedUpdate() turns them into movement.
public static class SeiFishInput
{
    [ModPatch("PlayerController", "GetInput", ModPatchWhen.After)]
    public static void AfterGetInput(PlayerController __instance)
    {
        SeiFishMod.InjectInput(__instance);
    }
}
