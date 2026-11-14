#nullable enable

namespace NeuroSdk.Websocket
{
    public sealed class ExecutionResult
    {
        public bool Successful { get; }
        public bool IsUnstable { get; }
        public string? Message { get; }

        private ExecutionResult(bool success, string? message, bool unstable = false)
        {
            Successful = success;
            Message = message;
            IsUnstable = unstable;
        }

        public static ExecutionResult Success(string? message = null) => new(true, message);
        public static ExecutionResult Failure(string reason) => new(false, reason);
        ///<summary>
        /// use this when Something went wrong on our side. And having neuro retry wouldn't help
        ///<summary>
        public static ExecutionResult Unstable(string reason) => new(false, reason, true);
        public static ExecutionResult VedalFailure(string reason) => Unstable(reason + NeuroSdkStrings.VedalFaultSuffix);
        public static ExecutionResult ModFailure(string reason) => Unstable(reason + NeuroSdkStrings.ModFaultSuffix);
    }
}
