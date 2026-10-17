using Hangar.Core.Users;
using Hangar.Core.Workspaces;

namespace Hangar.Api.Realtime;

// Placeholder sinks until the SignalR realtime module is wired (slice S3).
internal sealed class NoopPolicySink : IPolicyChangeSink
{
    public Task PolicyChangedAsync(Guid serverId, long policyVersion, IReadOnlyCollection<Guid>? affectedUsers, CancellationToken ct) => Task.CompletedTask;
}

internal sealed class NoopProfileSink : IProfileChangeSink
{
    public Task ProfileChangedAsync(Guid userId, CancellationToken ct) => Task.CompletedTask;
}
