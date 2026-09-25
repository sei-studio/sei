-- Sei companion helper for Don't Starve Together (server-only).
-- Installed and force-enabled by the Sei desktop app; inert until Sei asks.
-- No configuration: discovery probes a fixed set of local ports (modmain.lua
-- PORTS) until the Sei app answers, so there is nothing to set on either side.
name = "Sei companion"
description = "Lets a Sei companion join your world as a survivor. Server-side only; joining friends need nothing. The mod does nothing unless the Sei app is running."
author = "Sei"
version = "0.3.0"
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
