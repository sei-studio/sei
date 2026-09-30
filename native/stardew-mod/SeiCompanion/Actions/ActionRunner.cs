using System;
using System.Collections.Generic;
using System.Text.Json;

namespace SeiCompanion.Actions
{
    /// <summary>The terminal value an action yields.</summary>
    public sealed class Result
    {
        public bool Ok { get; }
        public string Detail { get; }
        public Dictionary<string, object> Extra { get; }

        public Result(bool ok, string detail, Dictionary<string, object> extra = null)
        {
            this.Ok = ok;
            this.Detail = detail ?? "";
            this.Extra = extra;
        }

        public static Result Success(string detail, Dictionary<string, object> extra = null) => new Result(true, detail, extra);
        public static Result Fail(string detail) => new Result(false, detail);
    }

    /// <summary>Yield this to wait a wall-clock delay (in ticks at 60 Hz).</summary>
    public readonly struct WaitTicks
    {
        public int Ticks { get; }
        public WaitTicks(int ticks) { this.Ticks = Math.Max(1, ticks); }
        public static WaitTicks Ms(int ms) => new WaitTicks(Math.Max(1, ms * 60 / 1000));
    }

    /// <summary>
    /// What a verb sees: its arguments, the body, cancellation, and a progress
    /// sink whose text rides `progress` frames to the bot.
    /// </summary>
    public sealed class ActionContext
    {
        public Body.SeiBody Body { get; }
        public JsonElement Args { get; }
        public string Id { get; }
        public bool Cancelled { get; internal set; }
        public string CancelReason { get; internal set; }

        public ActionContext(Body.SeiBody body, string id, JsonElement args)
        {
            this.Body = body;
            this.Id = id;
            this.Args = args;
        }

        public void Progress(string text) => this.Body.Session?.SendProgress(this.Id, text);

        public string Str(string key, string fallback = null)
        {
            if (this.Args.ValueKind != JsonValueKind.Object || !this.Args.TryGetProperty(key, out JsonElement e))
                return fallback;
            return e.ValueKind == JsonValueKind.String ? e.GetString() : e.ValueKind == JsonValueKind.Null || e.ValueKind == JsonValueKind.Undefined ? fallback : e.ToString();
        }

        public int? Int(string key)
        {
            if (this.Args.ValueKind != JsonValueKind.Object || !this.Args.TryGetProperty(key, out JsonElement e))
                return null;
            if (e.ValueKind == JsonValueKind.Number && e.TryGetDouble(out double d))
                return (int)Math.Round(d);
            if (e.ValueKind == JsonValueKind.String && double.TryParse(e.GetString(), out double s))
                return (int)Math.Round(s);
            return null;
        }

        public bool Bool(string key, bool fallback = false)
        {
            if (this.Args.ValueKind != JsonValueKind.Object || !this.Args.TryGetProperty(key, out JsonElement e))
                return fallback;
            return e.ValueKind == JsonValueKind.True ? true : e.ValueKind == JsonValueKind.False ? false : fallback;
        }
    }

    /// <summary>
    /// Coroutine host for verbs. A verb is an iterator that yields:
    ///   null           advance again next tick
    ///   WaitTicks      sleep that many ticks
    ///   IEnumerable    run a sub-routine to completion first
    ///   Result         finish (the result goes to the bot)
    /// One runner per body; one command in flight at a time (the brain is
    /// single-flight too: a new command supersedes the running one).
    /// </summary>
    public sealed class ActionRunner
    {
        private readonly Stack<IEnumerator<object>> _stack = new Stack<IEnumerator<object>>();
        private int _sleepTicks;

        public ActionContext Context { get; private set; }
        public string ActionName { get; private set; }
        public bool Busy => this.Context != null;

        public event Action<ActionContext, string, Result> Finished;

        public void Start(ActionContext ctx, string name, IEnumerable<object> routine)
        {
            this.Abort("superseded by a new command");
            this.Context = ctx;
            this.ActionName = name;
            this._sleepTicks = 0;
            this._stack.Clear();
            this._stack.Push(routine.GetEnumerator());
        }

        public void Abort(string reason)
        {
            if (this.Context == null)
                return;
            ActionContext ctx = this.Context;
            ctx.Cancelled = true;
            ctx.CancelReason = reason;
            this.Finish(Result.Fail(reason));
        }

        private void Finish(Result result)
        {
            ActionContext ctx = this.Context;
            string name = this.ActionName;
            this.Context = null;
            this.ActionName = null;
            while (this._stack.Count > 0)
            {
                try { this._stack.Pop().Dispose(); } catch { }
            }
            this.Finished?.Invoke(ctx, name, result);
        }

        /// <summary>Advance the running verb by one tick.</summary>
        public void Tick()
        {
            if (this.Context == null)
                return;
            if (this._sleepTicks > 0)
            {
                this._sleepTicks--;
                return;
            }
            // Advance at most one yield per tick per stack level; a sub-routine
            // that finishes lets its parent continue on the same tick.
            for (int guard = 0; guard < 8 && this._stack.Count > 0; guard++)
            {
                IEnumerator<object> top = this._stack.Peek();
                bool moved;
                try
                {
                    moved = top.MoveNext();
                }
                catch (Exception ex)
                {
                    this.Finish(Result.Fail($"error: {ex.Message}"));
                    return;
                }
                if (!moved)
                {
                    this._stack.Pop();
                    if (this._stack.Count == 0)
                    {
                        this.Finish(Result.Success("done"));
                        return;
                    }
                    continue;
                }
                object y = top.Current;
                switch (y)
                {
                    case null:
                        return;
                    case Result r:
                        this.Finish(r);
                        return;
                    case WaitTicks w:
                        this._sleepTicks = w.Ticks;
                        return;
                    case IEnumerable<object> sub:
                        this._stack.Push(sub.GetEnumerator());
                        continue;
                    default:
                        return;
                }
            }
        }
    }
}
