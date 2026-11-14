using MegaCrit.Sts2.Core.Models.Cards;
using NeuroSdk.Actions;
using NeuroSdk.Json;
using NeuroSdk.Websocket;
using Sts2Agent;

namespace STS2NeuroIntegration;

public abstract class NeuroActionUnsafe : BaseNeuroAction
{
    protected abstract ExecutionResult ValidateUnsafe(ActionJData actionData, out object? parsedData);
    protected abstract void ExecuteUnsafe(object? parsedData);

    protected sealed override ExecutionResult Validate(ActionJData actionData, out object? parsedData)
    {
        ExecutionResult result = ValidateUnsafe(actionData, out object? tParsedData);
        parsedData = tParsedData;
        return result;
    }

    protected sealed override void Execute(object? parsedData) => ExecuteUnsafe(parsedData);
}
public class ConstructedAction(string name, string description, JsonSchema? schema = null) : NeuroActionUnsafe
{

    public override string Name => name;

    protected override string Description => description!;

    private JsonSchema? _schema = schema;
    public ActionJData Data;

    protected override JsonSchema? Schema => _schema;

    protected override void ExecuteUnsafe(object? parsedData)
    {
        ActionExecutor.Execute(this, parsedData);
    }

    protected override ExecutionResult ValidateUnsafe(ActionJData actionData, out object? parsedData)
    {
        Data = actionData;
        return ActionExecutor.Validate(this, actionData, out parsedData);
    }

    public void SetSchema(JsonSchema Schema) => _schema = Schema;

    public override string ToString()
    {
        return $"[{Name}] {description},  jsonSchema {Schema}";
    }

    public bool HasSchema()
    {
        return Schema != null;
    }
}
