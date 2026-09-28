package gg.sei.autolan;

import net.minecraft.client.Minecraft;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;

/**
 * Minecraft 26.2 and newer: the LAN screen became Multiplayer Options with a
 * scope (off / LAN), and the game mode and cheats for other players are world
 * settings of their own, so publishing leaves them as the world has them.
 */
final class Compat {
	private Compat() {}

	static boolean publish(IntegratedServer server, int port) {
		return server.publishServer(MinecraftServer.MultiplayerScope.LAN, port);
	}

	static Component publishedMessage(int port) {
		return Component.translatable("menu.multiplayerOptions.publish.started.lan", String.valueOf(port))
			.append(Component.literal(" (Sei: world opened for your companion)"));
	}

	static Component failedMessage() {
		return Component.translatable("commands.publish.failed");
	}

	static void chat(Minecraft mc, Component message) {
		mc.gui.hud.getChat().addClientSystemMessage(message);
	}

	/** The window title gains "(LAN)", as after the vanilla screen. */
	static void updateTitle(Minecraft mc) {
		mc.updateTitle();
	}
}
