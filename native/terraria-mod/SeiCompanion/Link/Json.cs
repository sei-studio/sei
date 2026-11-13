// Sei companion for tModLoader. MIT License, see native/terraria-mod/LICENSE.
// Small readers over System.Text.Json.Nodes so handlers never throw on a
// missing or mistyped field.

using System;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace SeiCompanion.Link
{
	public static class Json
	{
		public static string Str(JsonObject o, string key, string fallback = null)
		{
			try
			{
				if (o != null && o.TryGetPropertyValue(key, out var n) && n is JsonValue v)
				{
					if (v.TryGetValue<string>(out var s)) return s;
					return v.ToJsonString().Trim('"');
				}
			}
			catch { }
			return fallback;
		}

		public static int Int(JsonObject o, string key, int fallback = 0)
		{
			try
			{
				if (o != null && o.TryGetPropertyValue(key, out var n) && n is JsonValue v)
				{
					if (v.TryGetValue<int>(out var i)) return i;
					if (v.TryGetValue<double>(out var d)) return (int)Math.Round(d);
					if (v.TryGetValue<string>(out var s) && int.TryParse(s.TrimStart('#'), out var p)) return p;
				}
			}
			catch { }
			return fallback;
		}

		public static int? IntOrNull(JsonObject o, string key)
		{
			if (o == null || !o.ContainsKey(key) || o[key] == null) return null;
			int sentinel = int.MinValue;
			int v = Int(o, key, sentinel);
			return v == sentinel ? null : v;
		}

		public static bool Bool(JsonObject o, string key, bool fallback = false)
		{
			try
			{
				if (o != null && o.TryGetPropertyValue(key, out var n) && n is JsonValue v)
				{
					if (v.TryGetValue<bool>(out var b)) return b;
					if (v.TryGetValue<string>(out var s)) return s == "true" || s == "1";
				}
			}
			catch { }
			return fallback;
		}

		public static JsonObject Obj(JsonObject o, string key)
		{
			try
			{
				if (o != null && o.TryGetPropertyValue(key, out var n)) return n as JsonObject;
			}
			catch { }
			return null;
		}

		public static string Serialize(JsonNode node) => node.ToJsonString(new JsonSerializerOptions { WriteIndented = false });
	}
}
