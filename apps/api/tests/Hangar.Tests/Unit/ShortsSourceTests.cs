using Hangar.Api.Realtime;
using Hangar.Core.Common;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace Hangar.Tests.Unit;

public class ShortsSourceTests
{
    [Fact]
    public async Task Without_an_api_key_the_feed_explains_how_to_turn_it_on()
    {
        var source = new YouTubeShortsSource(new NoHttp(), Options.Create(new YouTubeOptions()), TimeProvider.System, NullLogger<YouTubeShortsSource>.Instance);
        var e = await Assert.ThrowsAsync<AppProblem>(() => source.NextAsync(5, new HashSet<string>(), CancellationToken.None));
        Assert.Equal(503, e.Status);
        Assert.Equal("shorts.not_configured", e.Code);
    }

    private sealed class NoHttp : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => throw new InvalidOperationException("no calls expected");
    }
}
