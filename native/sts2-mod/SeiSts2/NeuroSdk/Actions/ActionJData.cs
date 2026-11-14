#nullable enable

using System;
using System.Text.Json.Nodes;
using NeuroSdk.Json;
using Sts2Agent;



namespace NeuroSdk.Actions
{
    /// <summary>
    /// A wrapper class for the data of an <see cref="NeuroSdk.Messages.Incoming.Action"/> message.
    /// </summary>
    public sealed class ActionJData : IJTokenWrapper
    {
        public JsonNode? Data { get; private set; }

        //TODO: Figure out if this can be made public...
        public ActionJData()
        {
        }

        private void DeserializeFromJson(string? stringifiedData)
        {
            if (stringifiedData is null or "")
            {
                Data = null;
                return;
            }

            // Native replacement for JToken.Parse
            Data = JsonNode.Parse(stringifiedData);
        }

        internal static bool TryParse(string? stringifiedData, out ActionJData? actionJData)
        {
            try
            {
                actionJData = new ActionJData();
                actionJData.DeserializeFromJson(stringifiedData);
                return true;
            }
            catch (Exception e)
            {
                // Note: JsonNode.Parse throws a JsonException if the JSON is invalid
                Plugin.LogError("Failed to deserialize ActionJData from string.");
                Plugin.LogError(e.ToString());
                actionJData = null;
                return false;
            }
        }
    }
}

