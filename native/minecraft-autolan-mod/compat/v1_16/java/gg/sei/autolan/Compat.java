package gg.sei.autolan;

import net.minecraft.client.Minecraft;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.TextComponent;
import net.minecraft.network.chat.TranslatableComponent;

/** Minecraft 1.16 to 1.18: WorldData.getAllowCommands, TextComponent. */
final class Compat {
	private Compat() {}

	/**
	 * Publish with the world's own game mode and its cheats setting, the
	 * choices the modern Open to LAN screen starts with. publishServer only
	 * applies them to players who join; the host keeps its own game mode.
	 */
	static boolean publish(IntegratedServer server, int port) {
		return server.publishServer(server.getDefaultGameType(), server.getWorldData().getAllowCommands(), port);
	}

	static Component publishedMessage(int port) {
		return new TranslatableComponent("commands.publish.started", port)
			.append(new TextComponent(" (Sei: world opened for your companion)"));
	}

	static Component failedMessage() {
		return new TranslatableComponent("commands.publish.failed");
	}

	static void chat(Minecraft mc, Component message) {
		mc.gui.getChat().addMessage(message);
	}

	/** The window title gains "(LAN)", as after the vanilla screen. */
	static void updateTitle(Minecraft mc) {
		mc.updateTitle();
	}
}
