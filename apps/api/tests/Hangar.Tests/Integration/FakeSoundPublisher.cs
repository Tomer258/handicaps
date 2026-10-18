using System.Collections.Concurrent;
using Hangar.Core.Soundboard;

namespace Hangar.Tests.Integration;

/// <summary>In-memory publisher worker: records allowlisted commands and answers with a configurable acknowledgement.</summary>
public sealed class FakeSoundPublisher : ISoundPublisher
{
    public const long Epoch = 42;
    public ConcurrentQueue<PublisherPlayCommand> Plays { get; } = new();
    public ConcurrentQueue<string> Stops { get; } = new();
    /// <summary>null = unreachable; otherwise the state returned for every play.</summary>
    public string? AckState { get; set; } = "playing";
    public ConcurrentDictionary<string, byte> Active { get; } = new();

    public Task<PublisherAck?> PlayAsync(PublisherPlayCommand command, CancellationToken ct)
    {
        Plays.Enqueue(command);
        if (AckState is null) return Task.FromResult<PublisherAck?>(null);
        if (AckState == "playing") Active[command.PlaybackId] = 0;
        return Task.FromResult<PublisherAck?>(new PublisherAck(AckState, Epoch, AckState == "playing" ? null : "refused"));
    }

    public Task StopAsync(string playbackId, CancellationToken ct)
    {
        Stops.Enqueue(playbackId);
        Active.TryRemove(playbackId, out _);
        return Task.CompletedTask;
    }

    public Task<PublisherHealth?> HealthAsync(CancellationToken ct) =>
        Task.FromResult<PublisherHealth?>(new PublisherHealth(Epoch, Active.Keys.ToList()));
}
