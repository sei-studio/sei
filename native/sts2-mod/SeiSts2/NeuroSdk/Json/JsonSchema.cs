#nullable enable

using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace NeuroSdk.Json
{
    public class JsonSchema
    {
        [JsonIgnore]
        public Dictionary<string, JsonSchema> Properties
        {
            get => _properties ??= new Dictionary<string, JsonSchema>();
            set => _properties = value;
        }

        [JsonIgnore]
        public JsonSchemaType Type
        {
            get
            {
                return _type switch
                {
                    "string" => JsonSchemaType.String,
                    "number" => JsonSchemaType.Float,
                    "integer" => JsonSchemaType.Integer,
                    "boolean" => JsonSchemaType.Boolean,
                    "object" => JsonSchemaType.Object,
                    "array" => JsonSchemaType.Array,
                    "null" => JsonSchemaType.Null,
                    _ => JsonSchemaType.None
                };
            }
            set
            {
                _type = value switch
                {
                    JsonSchemaType.String => "string",
                    JsonSchemaType.Float => "number",
                    JsonSchemaType.Integer => "integer",
                    JsonSchemaType.Boolean => "boolean",
                    JsonSchemaType.Object => "object",
                    JsonSchemaType.Array => "array",
                    JsonSchemaType.Null => "null",
                    _ => null
                };
            }
        }

        [JsonIgnore]
        public List<object> Enum
        {
            get => _enum ??= new List<object>();
            set => _enum = value;
        }

        [JsonIgnore]
        public List<string> Required
        {
            get => _required ??= new List<string>();
            set => _required = value;
        }

        #region Keywords

        [JsonInclude, JsonPropertyName("properties")]
        private Dictionary<string, JsonSchema>? _properties;

        [JsonInclude, JsonPropertyName("items")]
        public JsonSchema? Items { get; set; }

        [JsonInclude, JsonPropertyName("type")]
        private string? _type;

        [JsonInclude, JsonPropertyName("enum")]
        private List<object>? _enum;

        [JsonInclude, JsonPropertyName("const")]
        public virtual object? Const { get; set; }

        [JsonInclude, JsonPropertyName("minLength")]
        public int? MinLength { get; set; }

        [JsonInclude, JsonPropertyName("pattern")]
        public string? Pattern { get; set; }

        [JsonInclude, JsonPropertyName("maxLength")]
        public int? MaxLength { get; set; }

        [JsonInclude, JsonPropertyName("maximum")]
        public float? Maximum { get; set; }

        [JsonInclude, JsonPropertyName("exclusiveMinimum")]
        public float? ExclusiveMinimum { get; set; }

        [JsonInclude, JsonPropertyName("exclusiveMaximum")]
        public float? ExclusiveMaximum { get; set; }

        [JsonInclude, JsonPropertyName("minimum")]
        public float? Minimum { get; set; }

        [JsonInclude, JsonPropertyName("required")]
        private List<string>? _required;

        [JsonInclude, JsonPropertyName("minItems")]
        public int? MinItems { get; set; }

        [JsonInclude, JsonPropertyName("maxItems")]
        public int? MaxItems { get; set; }

        [JsonInclude, JsonPropertyName("uniqueItems")]
        public bool? UniqueItems { get; set; }

        [JsonInclude, JsonPropertyName("format")]
        public string? Format { get; set; }

        #endregion

        internal sealed class ConstNull : JsonSchema
        {
            [JsonInclude, JsonPropertyName("const")]
            public override object? Const { get; set; } = null;
        }
    }
}
