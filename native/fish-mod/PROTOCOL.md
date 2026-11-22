# sei_fish protocol

The body runs inside FISH as a C# mod. The bridge is two text files because the
mod sandbox refuses `System.Net` and `System.IO`.

| file | writer | reader | API |
| --- | --- | --- | --- |
| `cmd.txt` | Sei | mod | `LoadText` |
| `state.txt` | mod | Sei | `SaveText` |

Both live in `%USERPROFILE%\AppData\LocalLow\dmcaguy\FISH\ModData\sei_fish\`.
`ReadText` is **not** the same folder: it reads inside the mod directory.

The mod applies a command file only when its text changes, so Sei rewrites the
whole file each time.

## Commands (Sei to mod)

One verb per line, arguments separated by spaces.

| line | effect |
| --- | --- |
| `goto <x> <y>` | walk to `x`; hop only when `y` is above and the fish is grounded. Clears any combat stance. |
| `stop` | drop every intent, including `attack` and `fire`. |
| `shoot <x> <y>` | face `x` and hold the trigger. |
| `fire 0\|1` | trigger on or off, without changing the aim. |
| `attack 0\|1` | body picks the nearest living enemy, faces it and fires. |
| `jump` | one hop. |
| `weapon <n>` | hold equipped weapon `n` (`wc.Hold`). 0 based. |

`goto` and `attack` are mutually exclusive by design: a movement order cancels
auto-attack, otherwise the old stance keeps turning the fish away from where it
walks.

## State (mod to Sei)

Written every 6 frames, about 10 Hz. First line is a flat `key=value` list:

```
frame= level= patch= x= y= vx= vy= hp= maxhp= state= facing= grounded= fell=
stuck= attack= aim= weapon= melee= wc= weapons= held= movex= speed= money= kills=
```

- `patch`: how many times `PlayerController.GetInput` was patched in. It only
  grows if the `[ModPatch]` is bound.
- `x`, `y`: world position. FISH is 2D, so `y` is height.
- `state`: `idle`, `walk`, `jump`, `djump`, `fall`, `turn`, `taunt`.
- `fell`: lost the ground without jumping, so it walked off a ledge. The target
  is dropped.
- `stuck`: pushed against something for 20 frames, hopped twice and still made
  no progress. The target is dropped.
- `weapon`: `<object name>:<controller type>`, for example
  `Gun:GunController` or `Sword:SwordController`.
- `melee`: 1 when the held weapon is a `SwordController` or `WhipController`.
  Those inherit `GunController` but override `Shoot()` with an empty body, so
  they cannot be fired. While `attack` is on the body switches to the first
  non-melee weapon in the fish's own list by itself; `weapon <n>` still forces
  a specific one.
- `wc`: `list<count>,idx<index>` read from the private `equippedWeapons` and
  `currentWeaponIndex` through `ModFields`.
- `weapons`, `held`: the same numbers, easier to parse.

Then up to 16 lines, one per living enemy:

```
enemy type=<C# type> x=<x> y=<y> hp=<hp>
```

## Body rules

- Locomotion writes `PlayerController.moveX` after `GetInput`, because `Move()`
  turns `moveX` into `AddForce`. `rb.linearVelocity` is overwritten every frame
  by the controller and does nothing.
- `moveY` is never written. Height is reached by jumping.
- Firing needs `gun.hasShotCheck = true` first: `Shoot()` returns immediately
  while the game's own input path has not set it.

## Build

No .NET SDK is installed, so the game cannot build `code~` (it would drop the
whole mod). Compile with the VS Roslyn compiler and ship the dll:

```powershell
$csc='C:\Program Files\Microsoft Visual Studio\18\Insiders\MSBuild\Current\Bin\Roslyn\csc.exe'
$m='C:\Program Files (x86)\Steam\steamapps\common\FISH\FISH_Data\Managed'
$mod='C:\Users\liamv\Documents\My Games\FISH\Mods\sei_fish'
& $csc /nologo /target:library /langversion:9.0 /nostdlib+ /out:"$mod\code\SeiFish.dll" `
  /reference:"$m\mscorlib.dll" /reference:"$m\netstandard.dll" /reference:"$m\System.dll" `
  /reference:"$m\System.Core.dll" /reference:"$m\System.Runtime.dll" `
  /reference:"$m\Assembly-CSharp.dll" /reference:"$m\UnityEngine.dll" `
  /reference:"$m\UnityEngine.CoreModule.dll" /reference:"$m\UnityEngine.Physics2DModule.dll" `
  native\fish-mod\SeiFishMod.cs
```

The mod folder must contain only `mod.json` and `code\SeiFish.dll`. A dll is
never unloaded, so every code change needs a FISH restart.




