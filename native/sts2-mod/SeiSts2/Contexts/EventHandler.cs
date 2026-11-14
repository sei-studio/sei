using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Godot;
using MegaCrit.Sts2.Core.AutoSlay.Helpers;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Nodes.CommonUi;
using MegaCrit.Sts2.Core.Nodes.Events;
using MegaCrit.Sts2.Core.Nodes.GodotExtensions;
using MegaCrit.Sts2.Core.Nodes.Rooms;
using STS2NeuroIntegration;
using NeuroSdk.Actions;
using NeuroSdk.Websocket;
using Sts2Agent.Utilities;
using NeuroSdk.Json;
using System.Text;
using MegaCrit.Sts2.Core.Models.Events;
using MegaCrit.Sts2.Core.Nodes.Vfx;
using System.Reflection;
using MegaCrit.Sts2.Core.Entities.Ancients;

namespace Sts2Agent.Contexts;

public class EventContextHandler : IContextHandler<EventContextHandler.Result>
{

    private static readonly BindingFlags PrivateInstance = BindingFlags.NonPublic | BindingFlags.Instance;
    private static readonly FieldInfo? _architect_current_line = typeof(TheArchitect).GetField("_currentLineIndex", PrivateInstance);
    private static readonly FieldInfo? _architect_dialogue = typeof(TheArchitect).GetField("_dialogue", PrivateInstance);
    public class Result
    {
        internal NButton? Button;
    }
    public ContextType Type => ContextType.Event;

    //TODO: make this more robust. Context is a bit odd in some events
    public ContextReturn GetContext(ContextInfo ctx)
    {
        var eventRoom = ctx.EventRoom;
        var evt = eventRoom.LocalMutableEvent;
        if (evt == null)
        {
            return new ContextReturn($"You are in the Event: {eventRoom.CanonicalEvent.Title.GetUnformattedText()}");
        }

        StringBuilder eventBuilder = new();
        eventBuilder.AppendLine("## You are in an event");
        eventBuilder.AppendLine($"**Event name:** {TextHelper.SafeLocString(() => evt.Title)}");


        try
        {
            if (evt is not TheArchitect architect)
            {
                var desc = evt.Description;
                if (desc != null)
                {
                    eventBuilder.AppendLine();
                    eventBuilder.AppendLine("**Event description:**");
                    eventBuilder.AppendLine(desc.GetUnformattedText());
                }
                else
                {
                    eventBuilder.AppendLine();
                    eventBuilder.AppendLine("**Event description:**");
                    eventBuilder.AppendLine(TextHelper.SafeLocString(() => evt.InitialDescription));
                }
            }
            else
            {
                var current_index = _architect_current_line?.GetValue(architect) as int?;
                if (current_index != null && _architect_dialogue?.GetValue(architect) is AncientDialogue current_speech)
                {
                    var current_line = current_speech.Lines.ElementAtOrDefault(current_index.Value);
                    if (current_line == null)
                    {
                        eventBuilder.AppendLine();
                        eventBuilder.AppendLine("**Dialogue:**");
                        eventBuilder.AppendLine("No dialogue");
                    }
                    else
                    {
                        eventBuilder.AppendLine();
                        eventBuilder.AppendLine("**Dialogue:**");
                        eventBuilder.AppendLine((current_line.Speaker == AncientDialogueSpeaker.Ancient ? "The Architect" : "You") + ": " + current_line.LineText?.GetUnformattedText() ?? "No dialogue");
                    }
                }
            }

        }
        catch
        {
        }

        if (evt.CurrentOptions.Count > 0)
        {
            eventBuilder.AppendLine();
            eventBuilder.AppendLine("**Options:**");
        }
        for (int i = 0; i < evt.CurrentOptions.Count; i++)
        {
            MegaCrit.Sts2.Core.Events.EventOption? eventoption = evt.CurrentOptions[i];
            string optionTitle = TextHelper.SafeLocString(() => eventoption.Title);
            string optionState = eventoption.IsLocked ? "(Locked)" : "";
            eventBuilder.Append($"- '{i}': **{optionTitle}** {optionState}");

            try
            {
                var optDesc = eventoption.Description;
                if (optDesc != null)
                {
                    evt.DynamicVars.AddTo(optDesc);
                    eventBuilder.AppendLine(optDesc.GetUnformattedText());
                }
                else
                {
                    eventBuilder.AppendLine("No description");
                }

            }
            catch
            {

                eventBuilder.AppendLine("No description");
            }
        }

        var lockedOptions = evt.CurrentOptions.Where(option => option.IsLocked).ToList();
        if (lockedOptions.Count > 0)
        {
            eventBuilder.AppendLine();
            eventBuilder.AppendLine("**Locked options cannot currently be selected.**");
        }

        return new ContextReturn(eventBuilder.ToString());
    }

    public CommandReturn GetCommands(ContextInfo ctx)
    {
        var commands = new List<ConstructedAction>();
        var eventRoom = ctx.EventRoom;
        if (eventRoom == null) return new CommandReturn();

        var evt = eventRoom.LocalMutableEvent;
        if (evt == null) return new CommandReturn();

        if (evt.IsFinished)
        {
            commands.Add(new("proceed", "Finish the current event"));
        }
        else
        {
            commands.Add(new("select_event_option", "Select an option in the event", QJS.WrapObject(new Dictionary<string, JsonSchema>
            {
                ["option_index"] = QJS.Type(JsonSchemaType.Integer)
            })));
        }
        StringBuilder forceText = new();
        forceText.AppendLine("Select an event option:");

        for (int i = 0; i < evt.CurrentOptions.Count; i++)
        {
            MegaCrit.Sts2.Core.Events.EventOption? eventoption = evt.CurrentOptions[i];
            string optionTitle = TextHelper.SafeLocString(() => eventoption.Title);
            string optionState = eventoption.IsLocked ? "(Locked)" : "";
            forceText.Append($"- '{i}': **{optionTitle}** {optionState}");
        }
        return new CommandReturn(commands, ForceText: forceText.ToString());
    }

    public ExecutionResult Validate(ConstructedAction action, ActionJData data, Result parsedData, ContextInfo ctx)
    {
        var sceneRoot = SceneHelper.GetSceneRoot();
        if (sceneRoot == null)
            return ExecutionResult.ModFailure("Cannot access scene tree");

        if (action.Name == "proceed")
        {
            // Try proceed button
            var proceedButton = UiHelper.FindFirst<NProceedButton>(sceneRoot);
            if (proceedButton != null && proceedButton.IsVisibleInTree())
            {
                parsedData.Button = proceedButton;
                Plugin.LogDebug("Initial Proceed button");

                return ExecutionResult.Success();
            }

            // Finished events use NEventOptionButton with IsProceed=true
            var eventProceed = UiHelper.FindAll<NEventOptionButton>(sceneRoot)
                .FirstOrDefault(b => b.Option.IsProceed && b.IsVisibleInTree());
            if (eventProceed != null)
            {
                parsedData.Button = eventProceed;
                Plugin.LogDebug("After proceed button");
                return ExecutionResult.Success();
            }

            return ExecutionResult.Unstable("Couldn't find a proceed button. You are most likely stuck here...");
        }
        var optionIndex = data.GetValue("option_index", -1);
        if (optionIndex < 0)
        {
            return ExecutionResult.Failure("Invalid option index");
        }

        var allButtons = UiHelper.FindAll<NEventOptionButton>(sceneRoot);

        // Buttons are added to the container in CurrentOptions order,
        // so tree-order index matches the event option index
        var button = allButtons.ElementAtOrDefault(optionIndex);
        if (button == null)
        {
            Plugin.LogDebug($"Event button lookup: requested index={optionIndex}, found={allButtons.Count} buttons");
            return ExecutionResult.Unstable($"Event option at index '{optionIndex}' not found");
        }
        if (button.Option.IsLocked)
        {
            return ExecutionResult.Failure($"Event option at index '{optionIndex}' is locked");
        }
        parsedData.Button = button;

        return ExecutionResult.Success();
    }
    public async Task<ExecutionResult?> TryExecute(ConstructedAction action, Result result, ContextInfo ctx)

    {
        return action.Name switch
        {
            "select_event_option" => await SelectEventOption(result, ctx),
            "proceed" => await Proceed(result),
            _ => null
        };
    }

    private async Task<ExecutionResult> SelectEventOption(Result result, ContextInfo ctx)
    {

        // GameStabilityDetector.ResetWasStable();
        await GodotMainThread.ClickAsync(result.Button);
        Plugin.Log($"Selected event option {result.Button?.Name ?? "unknown"}");
        return ExecutionResult.Success("Event option selected");
    }

    private async Task<ExecutionResult> Proceed(Result result)
    {
        await GodotMainThread.ClickAsync(result.Button);
        Plugin.Log("Clicked event proceed");
        return ExecutionResult.Success("Proceeded");

    }

    /// <summary>
    /// If an ancient event is showing dialogue (hitbox visible), click it to advance.
    /// Returns true if dialogue was advanced.
    /// </summary>
    public static bool TryAdvanceAncientDialogue()
    {
        try
        {
            var sceneRoot = SceneHelper.GetSceneRoot();
            if (sceneRoot == null) return false;

            var ancientLayout = UiHelper.FindFirst<NAncientEventLayout>(sceneRoot);
            if (ancientLayout == null) return false;

            var hitbox = ancientLayout.GetNodeOrNull<NClickableControl>("%DialogueHitbox");
            if (hitbox == null || !hitbox.Visible || !hitbox.IsEnabled) return false;

            Plugin.LogDebug("Ancient dialogue detected, auto-advancing...");
            hitbox.EmitSignal(NClickableControl.SignalName.Released, hitbox);

            var timer = ancientLayout.GetTree().CreateTimer(0.6);
            timer.Connect("timeout", Callable.From(GameStabilityDetector.ScheduleStabilityCheck));
            return true;
        }
        catch (Exception e)
        {
            Plugin.LogError($"TryAdvanceAncientDialogue error: {e.Message}");
            return false;
        }
    }
}
