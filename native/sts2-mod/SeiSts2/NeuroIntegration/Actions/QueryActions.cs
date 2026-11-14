using System.Text;
using MegaCrit.Sts2.Core.Context;
using MegaCrit.Sts2.Core.Entities.Players;
using MegaCrit.Sts2.Core.Platform;
using MegaCrit.Sts2.Core.Runs;
using NeuroSdk.Actions;
using NeuroSdk.Json;
using NeuroSdk.Websocket;
using Sts2Agent;
using Sts2Agent.Contexts;
using Sts2Agent.Utilities;
using STS2NeuroIntegration;

class QueryInfo : NeuroAction
{
  public static bool Registered = false;
  public override string Name => "query_info";

  protected override string Description => "Query Info about yourself or an ally. If you don't include an ally index, it will default to send you info about yourself.";

  protected override JsonSchema? Schema => QJS.WrapObject(new Dictionary<string, JsonSchema>(){
    { "ally_index", QJS.Type(JsonSchemaType.Integer) }
  });

  private Player? player;


  protected override void Execute()
  {
    if (player == null)
    {
      Plugin.LogError("Player is null during Execute of QueryInfo, But it passed validation. This should not happen.");
      return;
    }
    StringBuilder sb = new();
    var pronoun = LocalContext.IsMe(player) ? "You" : $"They";
    var otherpronoun = LocalContext.IsMe(player) ? "your" : $"their";
    sb.AppendLine($"Information about {(LocalContext.IsMe(player) ? "Yourself" : PlatformUtil.GetPlayerNameRaw(RunManager.Instance.NetService.Platform, player.NetId))}:");
    sb.AppendLine($"Health: {player.Creature.CurrentHp}/{player.Creature.MaxHp}");
    sb.AppendLine($"Gold: {player.Gold}");
    sb.AppendLine($"{pronoun} are playing as \"{TextHelper.SafeLocString(() => player.Character.Title)}\".");
    sb.AppendLine($"{pronoun} have the following Relics:");
    sb.RepresentRelics(player.Relics);
    sb.AppendLine($"{pronoun} have the following Cards in {otherpronoun} Deck:");
    sb.RepresentDeck(player.Deck.Cards, MegaCrit.Sts2.Core.Entities.Cards.PileType.Deck);


    NeuroIntegration.SendContext(sb.ToString(), true);
  }

  protected override ExecutionResult Validate(ActionJData actionData)
  {
    var allyIndex = actionData.GetValue("ally_index", -1);
    var ctx = GameContext.Resolve();
    if (ctx == null)
    {
      return ExecutionResult.Failure("GameContext is not available");
    }
    if (ctx.RunState == null || ctx.RunState.Players == null)
    {
      return ExecutionResult.Failure("RunState is not available, Please wait until a run is started.");
    }
    if (allyIndex >= 0 && allyIndex >= ctx.RunState.Players.Count)
    {
      StringBuilder sb = new();
      sb.AppendLine($"Invalid ally index {allyIndex}. Valid indices are 0 to {ctx.RunState.Players.Count - 1}:");
      for (int i = 0; i < ctx.RunState.Players.Count; i++)
      {
        sb.AppendLine($"[{i}] {PlatformUtil.GetPlayerNameRaw(RunManager.Instance.NetService.Platform, ctx.RunState.Players[i].NetId)}");
      }
      return ExecutionResult.Failure(sb.ToString());
    }
    if (allyIndex >= 0)
    {
      player = ctx.RunState.Players[allyIndex];
    }
    else
    {
      player = LocalContext.GetMe(ctx.RunState.Players);
    }

    return ExecutionResult.Success();
  }
}
