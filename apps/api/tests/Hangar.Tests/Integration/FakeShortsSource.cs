using Hangar.Api.Realtime;
using Hangar.Core.Common;

namespace Hangar.Tests.Integration;

/// <summary>Endless numbered Shorts (s0000000001, …) instead of YouTube; <see cref="Problem"/> simulates an outage.</summary>
public sealed class FakeShortsSource : IShortsSource
{
    private int _next;
    public AppProblem? Problem { get; set; }

    public Task<IReadOnlyList<WatchItem>> NextAsync(int count, IReadOnlySet<string> exclude, CancellationToken ct)
    {
        if (Problem is not null) throw Problem;
        var items = new List<WatchItem>();
        while (items.Count < count)
        {
            var id = $"s{Interlocked.Increment(ref _next):D10}";
            if (!exclude.Contains(id)) items.Add(new WatchItem(id, $"Short {id}", true));
        }
        return Task.FromResult<IReadOnlyList<WatchItem>>(items);
    }
}
