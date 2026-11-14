using System.Collections.Generic;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Godot;
using MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect;
using MegaCrit.Sts2.Core.Runs;
using MegaCrit.Sts2.Core.Localization;
using Sts2Agent.Utilities;
using STS2NeuroIntegration;
using NeuroSdk.Websocket;
using NeuroSdk.Actions;
using NeuroSdk.Json;
using System.Text;
using MegaCrit.Sts2.Core.Nodes.CommonUi;
using MegaCrit.Sts2.Core.Saves;

namespace Sts2Agent.Contexts;

public class CharacterSelectHandler : IContextHandler<CharacterSelectHandler.Result>
{
    public class Result : IContextResult
    {
        internal NCharacterSelectButton SelectedCharacter;
        internal NConfirmButton EmbarkButton;
    }

    public ContextType Type => ContextType.CharacterSelect;

    public ContextReturn GetContext(ContextInfo ctx)
    {
        StringBuilder stringBuilder = new();
        var first_character = ctx.CharacterButtons!.FirstOrDefault(c => c.IsSelected);
        first_character ??= ctx.CharacterButtons!.First();
        stringBuilder.AppendLine("# Select a character and embark on your adventure to conquer the Spire!");
        stringBuilder.AppendLine($"# Currently selected character: {TextHelper.StripBBCode(first_character.Character.Title.GetFormattedText())}");
        stringBuilder.RepresentStartingCharacter(first_character.Character);
        stringBuilder.AppendLine();
        stringBuilder.AppendLine(GetForceText(ctx));


        return new ContextReturn(stringBuilder.ToString());
    }

    private string GetForceText(ContextInfo ctx)
    {
        if (ctx.CharacterButtons == null || ctx.CharacterButtons.Count == 0)
            return "No characters found";

        var forceText = new StringBuilder();
        forceText.AppendLine("You can select a character using the following indices. If you are happy with your selection, Embark on a new Run");
        forceText.AppendLine("The available characters are:");
        for (int i = 0; i < ctx.CharacterButtons.Count; i++)
        {
            var btn = ctx.CharacterButtons[i];
            if (!GodotObject.IsInstanceValid(btn) || btn.IsLocked) continue;
            forceText.AppendLine($"- '{i}': {GetCharacterName(btn)}");
        }
        return forceText.ToString();
    }

    public CommandReturn GetCommands(ContextInfo ctx)
    {
        var commands = new List<ConstructedAction>();
        if (ctx.CharacterButtons == null) return new CommandReturn();

        var prompt = new StringBuilder();
        prompt.AppendLine("Select a character to start your run with:");

        for (int i = 0; i < ctx.CharacterButtons.Count; i++)
        {
            var btn = ctx.CharacterButtons[i];
            if (!GodotObject.IsInstanceValid(btn) || btn.IsLocked) continue;
            prompt.AppendLine($"- [{i}] {GetCharacterName(btn)}");
        }
        commands.Add(new ConstructedAction("select_character", "Select a different character at the start of your run", QJS.WrapObject(new Dictionary<string, JsonSchema>
        {
            ["character_index"] = QJS.Type(JsonSchemaType.Integer)
        }
        )));

        if (ctx.CharacterSelectScreen != null && GodotObject.IsInstanceValid(ctx.CharacterSelectScreen))
        {
            if (ctx.CharacterSelectScreen.GetNode<Control>("ConfirmButton") is NConfirmButton embarkButton
                && embarkButton.IsEnabled)
                commands.Add(new ConstructedAction("embark", "Start a new run with the currently selected character"));
        }

        return new CommandReturn(commands, ForceText: GetForceText(ctx));
    }


    public ExecutionResult Validate(ConstructedAction action, ActionJData data, Result parsedData, ContextInfo ctx)
    {
        if (action.Name == "select_character")
        {
            var character_index = data.GetValue("character_index", -1);
            if (character_index < 0)
                return ExecutionResult.Failure("Character index not found");

            var btn = ctx?.CharacterButtons?.ElementAtOrDefault(character_index);
            if (!GodotObject.IsInstanceValid(btn))
                return ExecutionResult.Failure("Character not found");
            if (btn.IsLocked)
                return ExecutionResult.Failure("Character is locked");

            parsedData.SelectedCharacter = btn;

            return ExecutionResult.Success();
        }
        else if (action.Name == "embark")
        {

            if (ctx.CharacterSelectScreen != null && GodotObject.IsInstanceValid(ctx.CharacterSelectScreen))
            {
                if (ctx.CharacterSelectScreen.GetNode<Control>("ConfirmButton") is MegaCrit.Sts2.Core.Nodes.CommonUi.NConfirmButton embarkButton
                    && embarkButton.IsEnabled)
                {

                    parsedData.EmbarkButton = embarkButton;
                    return ExecutionResult.Success();
                }
            }
            return ExecutionResult.Failure("Couldn't find the Embark button");
        }
        return ExecutionResult.ModFailure("Unknown action for character selection. Only select_character and embark are valid actions.");
    }
    public async Task<ExecutionResult?> TryExecute(ConstructedAction action, Result result, ContextInfo ctx)
    {
        if (action.Name == "select_character")
        {

            await GodotMainThread.RunAsync(() => result.SelectedCharacter.Select());

            var name = GetCharacterName(result.SelectedCharacter);
            var character = result.SelectedCharacter.Character;
            StringBuilder character_descriptor = new();
            character_descriptor.AppendLine($"# Selected {name}");
            character_descriptor.RepresentStartingCharacter(character);

            // GameStabilityDetector.ResetWasStable();
            Plugin.Log($"Selected character: {name}");
            NeuroIntegration.SendContext(character_descriptor.ToString());
            return ExecutionResult.Success($"Selected character: {name}");
        }

        if (action.Name == "embark")
        {
            var screen = ctx.CharacterSelectScreen;
            if (screen == null || !GodotObject.IsInstanceValid(screen))
                return ExecutionResult.Failure("Character select screen not found");

            var embarkButton = result.EmbarkButton;
            if (embarkButton == null)
                return ExecutionResult.Failure("Embark button not found");
            if (!embarkButton.IsEnabled)
                return ExecutionResult.Failure("Embark button is not enabled (select a character first)");

            //This hides the initial asking prompt for tutorials, just disabling it before the first popup to not interupt future embarks
            if (!SaveManager.Instance.SeenFtue("accept_tutorials_ftue"))
            {
                SaveManager.Instance.MarkFtueAsComplete("accept_tutorials_ftue");
                SaveManager.Instance.SetFtuesEnabled(false);
            }

            await GodotMainThread.ClickAsync(embarkButton);


            // Wait for the run to start (RunManager becomes active)
            for (int i = 0; i < 100; i++)
            {
                await Task.Delay(200);
                if (RunManager.Instance?.IsInProgress == true)
                    break;
            }



            Plugin.Log("Embarked on run");
            return ExecutionResult.Success("Embarked on the run");
        }

        return null;
    }

    private static string GetCharacterName(NCharacterSelectButton btn)
    {
        var character = btn.Character;
        if (character == null) return "unknown";
        return TextHelper.StripBBCode(character.Title.GetFormattedText());
    }
}
