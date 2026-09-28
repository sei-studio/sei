package gg.sei.autolan.mixin;

import gg.sei.autolan.SeiAutoLan;
import net.minecraft.client.Minecraft;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * The mod's only hook: the end of every client tick. Polling the tick rather
 * than hooking the world-join path keeps the mod on one injection point that
 * every Minecraft release since 1.14 has, while the join flow itself has been
 * rewritten several times.
 */
@Mixin(Minecraft.class)
public abstract class MinecraftMixin {
	@Inject(method = "tick", at = @At("TAIL"), require = 0)
	private void seiAutoLan$afterTick(CallbackInfo ci) {
		SeiAutoLan.onClientTick((Minecraft) (Object) this);
	}
}
