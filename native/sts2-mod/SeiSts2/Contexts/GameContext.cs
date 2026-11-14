using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using System.Linq;
using Godot;
using MegaCrit.Sts2.Core.AutoSlay.Helpers;
using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Entities.Merchant;
using MegaCrit.Sts2.Core.Nodes.Cards;
using MegaCrit.Sts2.Core.Nodes.Cards.Holders;
using MegaCrit.Sts2.Core.Nodes.Combat;
using MegaCrit.Sts2.Core.Nodes.Events.Custom.CrystalSphere;
using MegaCrit.Sts2.Core.Nodes.Screens;
using MegaCrit.Sts2.Core.Nodes.Screens.CardSelection;
using MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect;
using MegaCrit.Sts2.Core.Nodes.Screens.GameOverScreen;
using MegaCrit.Sts2.Core.Nodes.Screens.MainMenu;
using MegaCrit.Sts2.Core.Nodes.Screens.Map;
using MegaCrit.Sts2.Core.Nodes.Screens.Overlays;
using MegaCrit.Sts2.Core.Nodes.Screens.Timeline;
using MegaCrit.Sts2.Core.Rooms;
using MegaCrit.Sts2.Core.Runs;
using Sts2Agent.Utilities;

namespace Sts2Agent.Contexts;

public enum ContextType
{
    Map,
    HandSelection,
    CardSelection,
    Rewards,
    Combat,
    Event,
    RestSite,
    Shop,
    Treasure,
    BundleSelection,
    GameOver,
    CharacterSelect,
    MainMenu,
    CrystalBallEvent,
    TimelinesEvent,
    Unknown,
}

public class ContextInfo : IEqualityComparer<ContextInfo>
{
    public ContextType Type { get; init; }
    public RunState? RunState { get; init; }

    // Character select (no run yet)
    public NCharacterSelectScreen? CharacterSelectScreen { get; init; }
    public List<NCharacterSelectButton>? CharacterButtons { get; init; }

    // Map
    public List<MegaCrit.Sts2.Core.Map.MapPoint>? AvailableMapNodes { get; init; }

    // Hand selection
    public NPlayerHand? Hand { get; init; }

    // Card selection overlay
    public object? OverlayScreen { get; init; }
    public Node? OverlayNode { get; init; }
    public List<NCardHolder>? CardHolders { get; init; }
    public bool IsGridScreen { get; init; }

    // Bundle selection overlay
    public NChooseABundleSelectionScreen? BundleScreen { get; init; }
    public List<NCardBundle>? Bundles { get; init; }

    // Rewards
    public NRewardsScreen? RewardsScreen { get; init; }

    // Combat
    public CombatState? CombatState { get; init; }

    // Rooms
    public EventRoom? EventRoom { get; init; }
    public RestSiteRoom? RestSiteRoom { get; init; }
    public MerchantRoom? MerchantRoom { get; init; }
    public MerchantInventory? ShopInventory { get; init; }
    public bool ShopIsOpen { get; init; }
    public List<MerchantEntry>? ShopItems { get; init; }

    // Crystal ball Event
    public NCrystalSphereScreen? CrystalSphereScreen { get; init; }
    // Timelines
    public NTimelineScreen? TimelineScreen { get; init; }

    public bool Equals(ContextInfo? x, ContextInfo? y)
    {
        // Contexts are considered equal if they have the same type and the same relevant screen or state references (e.g. same combat, same map screen, etc.)
        if (x == null || y == null) return false;
        if (x.Type != y.Type) return false;

        return x switch
        {
            { Type: ContextType.CharacterSelect } => GodotObject.IsInstanceValid(x.CharacterSelectScreen) && GodotObject.IsInstanceValid(y.CharacterSelectScreen) && x.CharacterSelectScreen == y.CharacterSelectScreen,
            { Type: ContextType.Map } => true, // Map context is determined by run state, which is already checked by reference equality in RunState
            { Type: ContextType.HandSelection } => GodotObject.IsInstanceValid(x.Hand) && GodotObject.IsInstanceValid(y.Hand) && x.Hand == y.Hand,
            { Type: ContextType.CardSelection } => GodotObject.IsInstanceValid(x.OverlayNode) && GodotObject.IsInstanceValid(y.OverlayNode) && x.OverlayNode == y.OverlayNode,
            { Type: ContextType.Rewards } => GodotObject.IsInstanceValid(x.OverlayNode) && GodotObject.IsInstanceValid(y.OverlayNode) && x.OverlayNode == y.OverlayNode,
            { Type: ContextType.Combat } => x.CombatState != null && y.CombatState != null && x.CombatState == y.CombatState,
            { Type: ContextType.Event } => x.EventRoom != null && y.EventRoom != null && x.EventRoom == y.EventRoom && x.EventRoom.CanonicalEvent == y.EventRoom.CanonicalEvent,
            { Type: ContextType.RestSite } => x.RestSiteRoom != null && y.RestSiteRoom != null && x.RestSiteRoom == y.RestSiteRoom && x.RestSiteRoom.Options == y.RestSiteRoom.Options,
            { Type: ContextType.Shop } => x.MerchantRoom != null && y.MerchantRoom != null && x.MerchantRoom == y.MerchantRoom && x.MerchantRoom.GetLocalInventory().AllEntries == y.MerchantRoom.GetLocalInventory().AllEntries,
            { Type: ContextType.BundleSelection } => x.BundleScreen != null && y.BundleScreen != null && x.BundleScreen == y.BundleScreen && x.Bundles != null && y.Bundles != null && x.Bundles.SequenceEqual(y.Bundles),
            { Type: ContextType.GameOver } => true, // Game over context is determined by run state, which is already checked by reference equality in RunState
            { Type: ContextType.CrystalBallEvent } => GodotObject.IsInstanceValid(x.CrystalSphereScreen) && GodotObject.IsInstanceValid(y.CrystalSphereScreen) && x.CrystalSphereScreen == y.CrystalSphereScreen,
            { Type: ContextType.TimelinesEvent } => GodotObject.IsInstanceValid(x.TimelineScreen) && GodotObject.IsInstanceValid(y.TimelineScreen) && x.TimelineScreen == y.TimelineScreen,
            _ => true // For contexts where we don't have specific equality checks, default to true
        };
    }

    public int GetHashCode([DisallowNull] ContextInfo obj)
    {
        // Hash code should be consistent with Equals - contexts that are considered equal should have the same hash code
        if (obj == null) return 0;

        return obj.Type switch
        {
            ContextType.CharacterSelect => GodotObject.IsInstanceValid(obj.CharacterSelectScreen) ? obj.CharacterSelectScreen.GetHashCode() : 0,
            ContextType.Map => obj.RunState != null ? obj.RunState.GetHashCode() : 0,
            ContextType.HandSelection => GodotObject.IsInstanceValid(obj.Hand) ? obj.Hand.GetHashCode() : 0,
            ContextType.CardSelection => GodotObject.IsInstanceValid(obj.OverlayNode) ? obj.OverlayNode.GetHashCode() : 0,
            ContextType.Rewards => GodotObject.IsInstanceValid(obj.OverlayNode) ? obj.OverlayNode.GetHashCode() : 0,
            ContextType.Combat => obj.CombatState != null ? obj.CombatState.GetHashCode() : 0,
            ContextType.Event => obj.EventRoom != null ? HashCode.Combine(obj.EventRoom.GetHashCode(), obj.EventRoom.CanonicalEvent.GetHashCode()) : 0,
            ContextType.RestSite => obj.RestSiteRoom != null ? HashCode.Combine(obj.RestSiteRoom.GetHashCode(), obj.RestSiteRoom.Options.GetHashCode()) : 0,
            ContextType.Shop => obj.MerchantRoom != null ? HashCode.Combine(obj.MerchantRoom.GetHashCode(), obj.MerchantRoom.GetLocalInventory().AllEntries.GetHashCode()) : 0,
            ContextType.BundleSelection => obj.BundleScreen != null && obj.Bundles != null ? HashCode.Combine(obj.BundleScreen.GetHashCode(), obj.Bundles.Aggregate(0, (acc, b) => acc ^ b.GetHashCode())) : 0,
            ContextType.GameOver => obj.RunState != null ? obj.RunState.GetHashCode() : 0,
            ContextType.CrystalBallEvent => GodotObject.IsInstanceValid(obj.CrystalSphereScreen) ? obj.CrystalSphereScreen.GetHashCode() : 0,
            ContextType.TimelinesEvent => GodotObject.IsInstanceValid(obj.TimelineScreen) ? obj.TimelineScreen.GetHashCode() : 0,
            _ => 0
        };
    }
}

public static class GameContext
{
    // Cache card holders between serialization and action execution
    // to ensure consistent index mapping
    private static object? _cachedOverlayScreen;
    private static List<NCardHolder>? _cachedCardHolders;

    public static ContextInfo? Resolve()
    {
        var runState = RunManager.Instance?.DebugOnlyGetState();
        if (runState == null)
        {
            var sceneRoot = SceneHelper.GetSceneRoot();
            if (sceneRoot == null) return null;

            // Check character select screen first (it's a submenu on top of main menu)
            var charScreen = UiHelper.FindFirst<NCharacterSelectScreen>(sceneRoot);
            if (charScreen != null && charScreen.Visible)
            {
                var buttons = UiHelper.FindAll<NCharacterSelectButton>(charScreen);
                return new ContextInfo
                {
                    Type = ContextType.CharacterSelect,
                    CharacterSelectScreen = charScreen,
                    CharacterButtons = buttons
                };
            }

            var timelineScreens = UiHelper.FindFirst<NTimelineScreen>(sceneRoot);
            if (timelineScreens != null && timelineScreens.Visible)
            {
                return new ContextInfo
                {
                    Type = ContextType.TimelinesEvent,
                    TimelineScreen = timelineScreens
                };
            }

            // Check main menu (only when no submenus are open)
            var mainMenu = UiHelper.FindFirst<NMainMenu>(sceneRoot);
            if (mainMenu != null && mainMenu.Visible && !mainMenu.SubmenuStack.SubmenusOpen)
            {
                return new ContextInfo
                {
                    Type = ContextType.MainMenu
                };
            }

            return null;
        }

        // 1. Map screen
        if (NMapScreen.Instance is { IsOpen: true })
        {
            return new ContextInfo
            {
                Type = ContextType.Map,
                RunState = runState,
                AvailableMapNodes = GetAvailableMapNodes(runState)
            };
        }

        // 2. Overlay stack (game over, rewards, card selection)
        var overlayScreen = NOverlayStack.Instance?.Peek();

        // Game over screen takes priority over all other overlays
        if (overlayScreen is NGameOverScreen)
        {
            return new ContextInfo
            {
                Type = ContextType.GameOver,
                RunState = runState
            };
        }

        // Bundle/card pack selection screen
        if (overlayScreen is NChooseABundleSelectionScreen bundleScreen)
        {
            var bundles = UiHelper.FindAll<NCardBundle>((Node)bundleScreen);
            return new ContextInfo
            {
                Type = ContextType.BundleSelection,
                RunState = runState,
                OverlayScreen = bundleScreen,
                OverlayNode = (Node)bundleScreen,
                BundleScreen = bundleScreen,
                Bundles = bundles
            };
        }

        if (overlayScreen is Node overlayNode)
        {
            // Card selection overlay?
            // Use cached holders if same overlay screen, to keep indices consistent
            List<NCardHolder> cardHolders;
            if (_cachedOverlayScreen == overlayScreen && _cachedCardHolders != null
                && _cachedCardHolders.All(GodotObject.IsInstanceValid))
            {
                cardHolders = _cachedCardHolders;
            }
            else
            {
                cardHolders = overlayScreen is NCardGridSelectionScreen
                    ? UiHelper.FindAll<NGridCardHolder>(overlayNode).Cast<NCardHolder>().ToList()
                    : UiHelper.FindAll<NCardHolder>(overlayNode);
                _cachedOverlayScreen = overlayScreen;
                _cachedCardHolders = cardHolders;
            }
            if (cardHolders.Count > 0)
            {
                return new ContextInfo
                {
                    Type = ContextType.CardSelection,
                    RunState = runState,
                    OverlayScreen = overlayScreen,
                    OverlayNode = overlayNode,
                    CardHolders = cardHolders,
                    IsGridScreen = overlayScreen is NCardGridSelectionScreen
                };
            }

            // Rewards overlay?
            if (overlayScreen is NRewardsScreen rewardsScreen)
            {
                return new ContextInfo
                {
                    Type = ContextType.Rewards,
                    RunState = runState,
                    RewardsScreen = rewardsScreen,
                    OverlayNode = overlayNode
                };
            }
            if (overlayScreen is NCrystalSphereScreen CrystalSphereEvent)
            {
                return new ContextInfo
                {
                    Type = ContextType.CrystalBallEvent,
                    RunState = runState,
                    CrystalSphereScreen = CrystalSphereEvent
                };

            }

        }

        // 3. Hand card selection (discard/exhaust prompts during combat)
        var hand = NPlayerHand.Instance;
        if (hand != null && hand.IsInCardSelection)
        {
            return new ContextInfo
            {
                Type = ContextType.HandSelection,
                RunState = runState,
                Hand = hand
            };
        }

        // 4. Active combat
        var cm = CombatManager.Instance;
        if (cm != null && cm.IsInProgress && !cm.IsOverOrEnding)
        {
            return new ContextInfo
            {
                Type = ContextType.Combat,
                RunState = runState,
                CombatState = cm.DebugOnlyGetState()
            };
        }

        // 5. Room-based contexts
        var room = runState.CurrentRoom;

        if (room is EventRoom eventRoom)
        {
            return new ContextInfo
            {
                Type = ContextType.Event,
                RunState = runState,
                EventRoom = eventRoom,
            };
        }

        if (room is RestSiteRoom restRoom)
        {
            return new ContextInfo
            {
                Type = ContextType.RestSite,
                RunState = runState,
                RestSiteRoom = restRoom,
                AvailableMapNodes = GetAvailableMapNodes(runState)
            };
        }

        if (room is MerchantRoom shopRoom)
        {
            var inv = shopRoom.GetLocalInventory();
            var nRoom = MegaCrit.Sts2.Core.Nodes.Rooms.NMerchantRoom.Instance;
            bool isOpen = nRoom?.Inventory?.IsOpen == true;

            return new ContextInfo
            {
                Type = ContextType.Shop,
                RunState = runState,
                MerchantRoom = shopRoom,
                ShopInventory = inv,
                ShopIsOpen = isOpen,
                ShopItems = isOpen && inv != null ? BuildShopItems(inv) : null
            };
        }

        if (room is TreasureRoom)
        {
            return new ContextInfo
            {
                Type = ContextType.Treasure,
                RunState = runState
            };
        }

        return new ContextInfo
        {
            Type = ContextType.Unknown,
            RunState = runState
        };
    }

    private static List<MegaCrit.Sts2.Core.Map.MapPoint> GetAvailableMapNodes(RunState runState)
    {
        try
        {
            var map = runState.Map;
            var visited = runState.VisitedMapCoords;
            if (map == null)
                return [];
            if (visited.Count == 0)
                return [map.StartingMapPoint];

            var lastCoord = visited[visited.Count - 1];
            return map.GetPoint(lastCoord)?.Children.ToList()
                   ?? [];
        }
        catch
        {
            return [];
        }
    }

    public static List<MerchantEntry> BuildShopItems(MerchantInventory inv)
    {
        var entries = new List<MerchantEntry>();
        foreach (var e in inv.CharacterCardEntries.Concat(inv.ColorlessCardEntries))
            if (e.IsStocked) entries.Add(e);
        foreach (var e in inv.RelicEntries)
            if (e.IsStocked) entries.Add(e);
        foreach (var e in inv.PotionEntries)
            if (e.IsStocked) entries.Add(e);
        try { if (inv.CardRemovalEntry?.IsStocked == true) entries.Add(inv.CardRemovalEntry); } catch { }
        return entries;
    }
}
