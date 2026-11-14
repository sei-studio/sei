using Godot;

namespace Sts2Agent.Utilities;

public static class SceneHelper
{
    public static Node? GetSceneRoot()
    {
        try
        {
            return ((SceneTree)Engine.GetMainLoop()).Root;
        }
        catch
        {
            return null;
        }
    }
}
