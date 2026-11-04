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

    [Fact]
    public async Task A_refill_mixes_several_topics_instead_of_one()
    {
        var youtube = new FakeYouTube();
        var source = new YouTubeShortsSource(youtube, Options.Create(new YouTubeOptions { ApiKey = "k", BaseUrl = "https://yt.test/" }),
            TimeProvider.System, NullLogger<YouTubeShortsSource>.Instance);

        var first = await source.NextAsync(10, new HashSet<string>(), CancellationToken.None);

        Assert.Equal(3, youtube.Queries.Count);
        Assert.Equal(3, youtube.Queries.Distinct().Count());
        Assert.All(youtube.Queries, q => Assert.EndsWith("#shorts", q));
        // Ids carry the search they came from (first char): 10 picks from a shuffled 60 span more than one topic.
        Assert.True(first.Select(i => i.VideoId[0]).Distinct().Count() > 1);

        // Topics are not reused by the next refills.
        for (var n = 0; n < 8; n++) await source.NextAsync(10, new HashSet<string>(), CancellationToken.None);
        Assert.True(youtube.Queries.Count >= 6);
        Assert.Equal(youtube.Queries.Take(12).Count(), youtube.Queries.Take(12).Distinct().Count());
    }

    /// <summary>Answers every search with 20 unique ids, prefixed by the search number.</summary>
    private sealed class FakeYouTube : HttpMessageHandler, IHttpClientFactory
    {
        public List<string> Queries { get; } = [];

        public HttpClient CreateClient(string name) => new(this, disposeHandler: false);

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            char prefix;
            lock (Queries)
            {
                Queries.Add(Uri.UnescapeDataString(System.Web.HttpUtility.ParseQueryString(request.RequestUri!.Query)["q"]!));
                prefix = (char)('a' + Queries.Count - 1);
            }
            var items = string.Join(',', Enumerable.Range(0, 20).Select(i => "{\"id\":{\"videoId\":\"" + prefix + i.ToString("D10") + "\"},\"snippet\":{\"title\":\"t\"}}"));
            return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK)
            {
                Content = new StringContent($$"""{"items":[{{items}}]}""", System.Text.Encoding.UTF8, "application/json"),
            });
        }
    }

    private sealed class NoHttp : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => throw new InvalidOperationException("no calls expected");
    }
}
