using System.Collections.Concurrent;
using Hangar.Core.Users;

namespace Hangar.Api.Realtime;

public sealed class ConnectionInfo(string connectionId, Guid userId, Guid sessionId, Action abort)
{
    public string ConnectionId { get; } = connectionId;
    public Guid UserId { get; } = userId;
    public Guid SessionId { get; } = sessionId;
    public Action Abort { get; } = abort;
    public ConcurrentDictionary<Guid, byte> Channels { get; } = new();
    public DateTimeOffset LastHeartbeat { get; set; } = DateTimeOffset.UtcNow;
    public bool Idle { get; set; }
    /// <summary>Set once revoked: delivery is suppressed even before the socket actually closes.</summary>
    public bool Revoked { get; set; }
    /// <summary>Invocation budget (null = unlimited).</summary>
    public Hangar.Api.Infrastructure.TokenBucket? Budget { get; init; }
}

/// <summary>
/// In-process registry of hub connections (single API replica by design). Not an authorization boundary:
/// every delivery is still filtered against current permissions. Also aggregates presence across a user's connections.
/// </summary>
public sealed class ConnectionRegistry
{
    private readonly ConcurrentDictionary<string, ConnectionInfo> _connections = new();
    private readonly ConcurrentDictionary<Guid, PreferredStatus> _preferred = new();

    public void Add(ConnectionInfo c) => _connections[c.ConnectionId] = c;

    public ConnectionInfo? Remove(string connectionId) => _connections.TryRemove(connectionId, out var c) ? c : null;

    public ConnectionInfo? Get(string connectionId) => _connections.GetValueOrDefault(connectionId);

    public IReadOnlyList<ConnectionInfo> All() => _connections.Values.Where(c => !c.Revoked).ToList();

    public IReadOnlyList<ConnectionInfo> ForUser(Guid userId) => _connections.Values.Where(c => c.UserId == userId && !c.Revoked).ToList();

    public IReadOnlyList<ConnectionInfo> ForSessions(IReadOnlyCollection<Guid> sessionIds) =>
        _connections.Values.Where(c => sessionIds.Contains(c.SessionId)).ToList();

    public IReadOnlyList<ConnectionInfo> SubscribedTo(Guid channelId) =>
        _connections.Values.Where(c => !c.Revoked && c.Channels.ContainsKey(channelId)).ToList();

    public void SetPreferred(Guid userId, PreferredStatus status) => _preferred[userId] = status;

    public bool HasPreferred(Guid userId) => _preferred.ContainsKey(userId);

    /// <summary>online | idle | dnd | offline — what other members see. Invisible shows as offline.</summary>
    public string StatusOf(Guid userId)
    {
        var conns = ForUser(userId);
        if (conns.Count == 0) return "offline";
        var pref = _preferred.GetValueOrDefault(userId, PreferredStatus.Online);
        return pref switch
        {
            PreferredStatus.Invisible => "offline",
            PreferredStatus.DoNotDisturb => "dnd",
            PreferredStatus.Idle => "idle",
            _ => conns.All(c => c.Idle) ? "idle" : "online",
        };
    }

    public Dictionary<Guid, string> Snapshot() =>
        _connections.Values.Where(c => !c.Revoked).Select(c => c.UserId).Distinct().ToDictionary(u => u, StatusOf);

    /// <summary>Connections whose heartbeat expired (75 s) — presence must not rely on a clean disconnect.</summary>
    public IReadOnlyList<ConnectionInfo> Expired(TimeSpan timeout) =>
        _connections.Values.Where(c => DateTimeOffset.UtcNow - c.LastHeartbeat > timeout).ToList();
}
