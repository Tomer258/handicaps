using System.Collections.Concurrent;
using Hangar.Core.Media;

namespace Hangar.Tests.Integration;

/// <summary>In-memory RoomService stand-in: tests "connect" identities and observe removals/permission updates.</summary>
public sealed class FakeLiveKitRooms : ILiveKitRooms
{
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> _rooms = new();
    public ConcurrentQueue<(string Room, string Identity)> Removed { get; } = new();
    public ConcurrentDictionary<string, int> RoomSlots { get; } = new();
    public bool Down { get; set; }

    public void Connect(string room, string identity) => _rooms.GetOrAdd(room, _ => new())[identity] = 0;

    public bool IsConnected(string room, string identity) => _rooms.TryGetValue(room, out var r) && r.ContainsKey(identity);

    public Task EnsureRoomAsync(string room, int maxParticipants, CancellationToken ct)
    {
        Fail();
        _rooms.GetOrAdd(room, _ => new());
        RoomSlots[room] = maxParticipants;
        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<LiveKitParticipant>?> ListParticipantsAsync(string room, CancellationToken ct)
    {
        Fail();
        return Task.FromResult<IReadOnlyList<LiveKitParticipant>?>(_rooms.TryGetValue(room, out var r)
            ? r.Keys.Select(i => new LiveKitParticipant(i, null, null, [])).ToList()
            : null);
    }

    public Task<IReadOnlyList<string>> ListRoomsAsync(CancellationToken ct)
    {
        Fail();
        return Task.FromResult<IReadOnlyList<string>>(_rooms.Keys.ToList());
    }

    public Task RemoveParticipantAsync(string room, string identity, CancellationToken ct)
    {
        Fail();
        if (_rooms.TryGetValue(room, out var r)) r.TryRemove(identity, out _);
        Removed.Enqueue((room, identity));
        return Task.CompletedTask;
    }

    public Task UpdatePublishSourcesAsync(string room, string identity, IReadOnlyList<string> sources, CancellationToken ct) => Task.CompletedTask;

    public Task MuteTrackAsync(string room, string identity, string trackSid, bool muted, CancellationToken ct) => Task.CompletedTask;

    private void Fail()
    {
        if (Down) throw new LiveKitUnavailableException("fake LiveKit is down");
    }
}
