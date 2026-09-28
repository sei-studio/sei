package gg.sei.autolan;

import java.lang.ref.WeakReference;
import net.minecraft.client.Minecraft;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.util.HttpUtil;

/**
 * Opens a singleplayer world to LAN once it has loaded, so a Sei companion
 * (a bot on this same machine) can join it without Esc > Open to LAN.
 *
 * Runs on the client thread from {@code Minecraft.tick()}, the thread the
 * vanilla Open to LAN screen publishes from. It never touches a multiplayer
 * server or Realms: those have no integrated server. It tries each world
 * once; a world the player already opened is left alone.
 */
public final class SeiAutoLan {
	/** Client ticks to wait after the player is in the world (2 s). */
	private static final int SETTLE_TICKS = 40;

	/** The integrated server we already handled, so each world is tried once. */
	private static WeakReference<IntegratedServer> handled = new WeakReference<IntegratedServer>(null);
	private static int settle;
	/** Set after an unexpected error: the mod goes quiet rather than risk the game. */
	private static boolean disabled;

	private SeiAutoLan() {}

	public static void onClientTick(Minecraft mc) {
		if (disabled) return;
		try {
			tick(mc);
		} catch (Throwable t) {
			disabled = true;
			System.out.println("[sei-autolan] disabled after an error: " + t);
		}
	}

	private static void tick(Minecraft mc) {
		IntegratedServer server = mc.getSingleplayerServer();
		// Title screen, multiplayer server, Realms, or a world still loading.
		if (server == null || mc.player == null || mc.level == null) {
			settle = 0;
			return;
		}
		if (handled.get() == server) return;
		if (server.isPublished()) {
			handled = new WeakReference<IntegratedServer>(server);
			return;
		}
		if (++settle < SETTLE_TICKS) return;
		settle = 0;
		handled = new WeakReference<IntegratedServer>(server);
		open(mc, server);
	}

	private static void open(Minecraft mc, IntegratedServer server) {
		// A free port, as the vanilla screen picks. Sei finds it on its own
		// (a loopback scan plus a status ping), so any port works.
		int port = HttpUtil.getAvailablePort();
		boolean ok = Compat.publish(server, port);
		if (ok) {
			System.out.println("[sei-autolan] opened the world to LAN on port " + port);
			Compat.chat(mc, Compat.publishedMessage(port));
			Compat.updateTitle(mc);
		} else {
			System.out.println("[sei-autolan] could not open the world to LAN");
			Compat.chat(mc, Compat.failedMessage());
		}
	}
}
