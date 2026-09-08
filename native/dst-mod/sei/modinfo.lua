-- Sei companion helper for Don't Starve Together (server-only).
-- Installed and force-enabled by the Sei desktop app; inert until Sei asks.
name = "Sei companion"
description = "Lets a Sei companion join your world as a survivor. Server-side only; joining friends need nothing. The mod does nothing unless the Sei app is running."
author = "Sei"
version = "0.1.0"
forumthread = ""
api_version = 10
dst_compatible = true
dont_starve_compatible = false
reign_of_giants_compatible = false
all_clients_require_mod = false
client_only_mod = false
server_filter_tags = { "sei" }
priority = -1
configuration_options = {
    {
        name = "port",
        label = "Sei discovery port",
        hover = "The local port the Sei app listens on. Only change it if you changed it in Sei's settings too.",
        options = {
            { description = "27424 (default)", data = 27424 },
            { description = "27425", data = 27425 },
            { description = "27426", data = 27426 },
            { description = "27427", data = 27427 },
            { description = "27428", data = 27428 },
        },
        default = 27424,
    },
    {
        name = "announce",
        label = "Chat announcements",
        hover = "Also print what the companion says into the chat log, not only as a speech bubble.",
        options = {
            { description = "On", data = true },
            { description = "Off", data = false },
        },
        default = true,
    },
}
