using System.Net;
using static Hangar.Tests.Integration.Scenario;

namespace Hangar.Tests.Integration;

/// <summary>Link previews through the API: signed-in only, web links only, and internal addresses are never fetched.</summary>
[Collection("api")]
public class LinkPreviewApiTests(ApiFactory factory)
{
    [Fact]
    public async Task Previews_refuse_internal_addresses_and_non_web_links()
    {
        var (owner, _) = await OwnerAsync(factory);
        foreach (var target in new[] { "http://127.0.0.1:5432/", "http://169.254.169.254/latest/meta-data/", "http://localhost:7880/", "http://[::1]/" })
            Assert.Equal(HttpStatusCode.NoContent, (await owner.Http.GetAsync($"/api/v1/link-previews?url={Uri.EscapeDataString(target)}")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.Http.GetAsync($"/api/v1/link-previews?url={Uri.EscapeDataString("javascript:alert(1)")}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Http.GetAsync("/api/v1/link-previews/image?t=forged")).StatusCode);

        var anonymous = factory.NewClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.Http.GetAsync($"/api/v1/link-previews?url={Uri.EscapeDataString("https://example.com/")}")).StatusCode);
    }
}
