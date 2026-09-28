package gg.sei.autolan;

import net.minecraft.client.Minecraft;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.TextComponent;
import net.minecraft.network.chat.TranslatableComponent;
import net.minecraft.world.level.dimension.DimensionType;

/** Minecraft 1.14.4 and 1.15: level data per dimension, TextComponent. */
final class Compat {
	private Compat() {}

	/**
	 * Publish with the world's own game mode and its cheats setting, the
	 * choices the modern Open to LAN screen starts with. publishServer only
	 * applies them to players who join; the host keeps its own game mode.
	 */
	static boolean publish(IntegratedServer server, int port) {
		boolean cheats = server.getLevel(DimensionType.OVERWORLD).getLevelData().getAllowCommands();
		return server.publishServer(server.getDefaultGameType(), cheats, port);
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

	/** No LAN marker in the window title before 1.16. */
	static void updateTitle(Minecraft mc) {}
}
