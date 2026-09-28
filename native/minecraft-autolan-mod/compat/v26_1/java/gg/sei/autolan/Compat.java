package gg.sei.autolan;

import net.minecraft.client.Minecraft;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.network.chat.Component;

/** Minecraft 26.1 and newer: ChatComponent.addClientSystemMessage. */
final class Compat {
	private Compat() {}

	/**
	 * Publish with the world's own game mode and its cheats setting, the
	 * choices the modern Open to LAN screen starts with. publishServer only
	 * applies them to players who join; the host keeps its own game mode.
	 */
	static boolean publish(IntegratedServer server, int port) {
		return server.publishServer(server.getDefaultGameType(), server.getWorldData().isAllowCommands(), port);
	}

	static Component publishedMessage(int port) {
		return Component.translatable("commands.publish.started", port)
			.append(Component.literal(" (Sei: world opened for your companion)"));
	}

	static Component failedMessage() {
		return Component.translatable("commands.publish.failed");
	}

	static void chat(Minecraft mc, Component message) {
		mc.gui.getChat().addClientSystemMessage(message);
	}

	/** The window title gains "(LAN)", as after the vanilla screen. */
	static void updateTitle(Minecraft mc) {
		mc.updateTitle();
	}
}
