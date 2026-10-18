using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Hangar.Core.Files;
using Hangar.Core.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using static Hangar.Tests.Integration.Scenario;

namespace Hangar.Tests.Integration;

/// <summary>Attachments and avatars: allowlist by content, validator hand-off, channel-derived reads, GC.</summary>
[Collection("api")]
public class FileTests(ApiFactory factory)
{
    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4];

    private string StorageRoot => factory.Services.GetRequiredService<IOptions<StorageOptions>>().Value.Root;

    private static Task<HttpResponseMessage> UploadAsync(TestClient c, string path, byte[] bytes, string fileName)
    {
        var form = new MultipartFormDataContent();
        var file = new ByteArrayContent(bytes);
        file.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        form.Add(file, "file", fileName);
        return c.Http.PostAsync(path, form);
    }

    private static Task<HttpResponseMessage> SendWithAsync(TestClient c, Guid channelId, params Guid[] attachmentIds) =>
        c.Http.PostAsJsonAsync($"/api/v1/channels/{channelId}/messages", new { clientMessageId = Guid.NewGuid(), body = "", attachmentIds });

    [Fact]
    public async Task Image_attachment_is_normalized_then_readable_only_through_its_channel()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var (member, memberId) = await MemberAsync(factory, owner, serverId);
        var ch = await NewTextChannelAsync(owner, serverId);

        var up = await UploadAsync(owner, $"/api/v1/servers/{serverId}/attachments", Png, "../../shot.png");
        Assert.Equal(HttpStatusCode.Created, up.StatusCode);
        var dto = await Json(up);
        var id = dto.GetProperty("id").GetGuid();
        Assert.Equal("pending", dto.GetProperty("state").GetString());
        Assert.Equal("shot.png", dto.GetProperty("name").GetString()); // client path stripped
        Assert.Equal(HttpStatusCode.BadRequest, (await SendWithAsync(owner, ch, id)).StatusCode); // not ready yet

        await FakeValidator.RunAsync(factory, width: 1280, height: 720);
        var status = await Json(await owner.Http.GetAsync($"/api/v1/files/{id}/status"));
        Assert.Equal("ready", status.GetProperty("state").GetString());
        Assert.Equal("image/webp", status.GetProperty("mime").GetString());
        Assert.Equal(1280, status.GetProperty("width").GetInt32());
        Assert.Equal("shot.webp", status.GetProperty("name").GetString());
        Assert.Empty(Directory.GetFiles(Path.Combine(StorageRoot, "quarantine")));

        // Unlinked: only the uploader can read it (or see its status).
        Assert.Equal(HttpStatusCode.OK, (await owner.Http.GetAsync($"/api/v1/attachments/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await member.Http.GetAsync($"/api/v1/attachments/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await member.Http.GetAsync($"/api/v1/files/{id}/status")).StatusCode);

        var sent = await SendWithAsync(owner, ch, id);
        Assert.Equal(HttpStatusCode.Created, sent.StatusCode);
        var message = await Json(sent);
        var att = Assert.Single(message.GetProperty("attachments").EnumerateArray());
        Assert.Equal(720, att.GetProperty("height").GetInt32());
        Assert.Equal(HttpStatusCode.BadRequest, (await SendWithAsync(owner, ch, id)).StatusCode); // single-message use

        var read = await member.Http.GetAsync($"/api/v1/attachments/{id}");
        Assert.Equal(HttpStatusCode.OK, read.StatusCode);
        Assert.Equal("image/webp", read.Content.Headers.ContentType!.MediaType);
        Assert.Equal("nosniff", read.Headers.GetValues("X-Content-Type-Options").Single());
        Assert.Contains("sandbox", read.Headers.GetValues("Content-Security-Policy").Single());
        Assert.Equal("inline", read.Content.Headers.ContentDisposition!.DispositionType);
        Assert.Equal("attachment", (await member.Http.GetAsync($"/api/v1/attachments/{id}?download=true")).Content.Headers.ContentDisposition!.DispositionType);

        // Losing channel visibility removes file access; so does deleting the message.
        (await owner.Http.PutAsJsonAsync($"/api/v1/channels/{ch}/overrides", new { memberUserId = memberId, allow = 0, deny = 1 })).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.NotFound, (await member.Http.GetAsync($"/api/v1/attachments/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Http.DeleteAsync($"/api/v1/messages/{message.GetProperty("id").GetGuid()}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Http.GetAsync($"/api/v1/attachments/{id}")).StatusCode);
    }

    [Fact]
    public async Task Only_images_and_real_plain_text_are_accepted_and_text_always_downloads()
    {
        var (owner, serverId) = await OwnerAsync(factory);

        var exe = await UploadAsync(owner, $"/api/v1/servers/{serverId}/attachments", "MZ\x90\0\x03\0\0\0"u8.ToArray(), "setup.txt");
        Assert.Equal(HttpStatusCode.UnprocessableEntity, exe.StatusCode);
        Assert.Equal("file.unsupported", (await Json(exe)).GetProperty("code").GetString());
        var html = await UploadAsync(owner, $"/api/v1/servers/{serverId}/attachments", "<script>alert(1)</script>"u8.ToArray(), "x.html");
        Assert.Equal(HttpStatusCode.UnprocessableEntity, html.StatusCode);
        var svg = await UploadAsync(owner, $"/api/v1/servers/{serverId}/attachments", "<svg xmlns='http://www.w3.org/2000/svg'/>"u8.ToArray(), "x.svg");
        Assert.Equal(HttpStatusCode.UnprocessableEntity, svg.StatusCode);

        var txt = await UploadAsync(owner, $"/api/v1/servers/{serverId}/attachments", "שלום — notes\nline 2\n"u8.ToArray(), "notes.txt");
        Assert.Equal(HttpStatusCode.Created, txt.StatusCode);
        var dto = await Json(txt);
        Assert.Equal("ready", dto.GetProperty("state").GetString());
        var read = await owner.Http.GetAsync($"/api/v1/attachments/{dto.GetProperty("id").GetGuid()}");
        Assert.Equal("text/plain", read.Content.Headers.ContentType!.MediaType);
        Assert.Equal("attachment", read.Content.Headers.ContentDisposition!.DispositionType);
    }

    [Fact]
    public async Task Avatar_upload_replaces_the_previous_one_and_is_visible_to_server_members()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var (member, memberId) = await MemberAsync(factory, owner, serverId);

        var first = await UploadAsync(member, "/api/v1/users/me/avatar", Png, "me.png");
        Assert.Equal(HttpStatusCode.Accepted, first.StatusCode);
        var firstId = (await Json(first)).GetProperty("id").GetGuid();
        await FakeValidator.RunAsync(factory, width: 256, height: 256);
        var me = await Json(await member.Http.GetAsync("/api/v1/auth/me"));
        Assert.Equal(firstId, me.GetProperty("user").GetProperty("avatarAssetId").GetGuid());
        Assert.Equal(HttpStatusCode.OK, (await owner.Http.GetAsync($"/api/v1/avatars/{firstId}")).StatusCode);

        var second = (await Json(await UploadAsync(member, "/api/v1/users/me/avatar", Png, "me2.png"))).GetProperty("id").GetGuid();
        await FakeValidator.RunAsync(factory, width: 256, height: 256);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Http.GetAsync($"/api/v1/avatars/{firstId}")).StatusCode);
        var members = await Json(await owner.Http.GetAsync($"/api/v1/servers/{serverId}/members"));
        Assert.Equal(second, members.EnumerateArray().Single(m => m.GetProperty("userId").GetGuid() == memberId).GetProperty("avatarAssetId").GetGuid());

        // An oversized validator output is rejected, the current avatar stays.
        var third = (await Json(await UploadAsync(member, "/api/v1/users/me/avatar", Png, "big.png"))).GetProperty("id").GetGuid();
        await FakeValidator.RunAsync(factory, width: 4000, height: 4000);
        var rejected = await Json(await member.Http.GetAsync($"/api/v1/files/{third}/status"));
        Assert.Equal("rejected", rejected.GetProperty("state").GetString());
        Assert.Equal("output_invalid", rejected.GetProperty("rejectReason").GetString());

        Assert.Equal(HttpStatusCode.NoContent, (await member.Http.DeleteAsync("/api/v1/users/me/avatar")).StatusCode);
        Assert.Equal(JsonValueKindNull, (await Json(await member.Http.GetAsync("/api/v1/auth/me"))).GetProperty("user").GetProperty("avatarAssetId").ValueKind);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Http.GetAsync($"/api/v1/avatars/{second}")).StatusCode);
    }

    private const System.Text.Json.JsonValueKind JsonValueKindNull = System.Text.Json.JsonValueKind.Null;

    [Fact]
    public async Task Unlinked_attachments_are_garbage_collected_after_the_grace_period()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var dto = await Json(await UploadAsync(owner, $"/api/v1/servers/{serverId}/attachments", "temp\n"u8.ToArray(), "temp.txt"));
        var id = dto.GetProperty("id").GetGuid();
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HangarDbContext>();
            await db.Database.ExecuteSqlInterpolatedAsync($"UPDATE file_assets SET created_at = now() - interval '2 days' WHERE id = {id}");
            await scope.ServiceProvider.GetRequiredService<FileService>().CollectGarbageAsync(CancellationToken.None);
        }
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Http.GetAsync($"/api/v1/attachments/{id}")).StatusCode);
    }

    private int QuarantineCount()
    {
        factory.Services.GetRequiredService<LocalFileStore>(); // creates the areas
        return Directory.GetFiles(Path.Combine(StorageRoot, StorageArea.Quarantine)).Length;
    }

    private async Task<int> FileRowsAsync()
    {
        using var scope = factory.Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<HangarDbContext>().FileAssets.CountAsync();
    }

    [Fact]
    public async Task Low_disk_space_pauses_uploads_with_507()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var opts = factory.Services.GetRequiredService<IOptions<StorageOptions>>().Value;
        var before = opts.MinFreeMegabytes;
        var files = QuarantineCount();
        opts.MinFreeMegabytes = long.MaxValue / (2L * 1024 * 1024); // more than any disk has
        try
        {
            var r = await UploadAsync(owner, $"/api/v1/servers/{serverId}/attachments", Png, "a.png");
            Assert.Equal((HttpStatusCode)507, r.StatusCode);
            Assert.Equal("storage.full", (await Json(r)).GetProperty("code").GetString());
        }
        finally
        {
            opts.MinFreeMegabytes = before;
        }
        Assert.Equal(files, QuarantineCount());
        Assert.Equal(HttpStatusCode.Created, (await UploadAsync(owner, $"/api/v1/servers/{serverId}/attachments", Png, "a.png")).StatusCode);
    }

    /// <summary>Sends part of the body, then fails like a dropped connection.</summary>
    private sealed class BrokenContent(int sendBytes) : HttpContent
    {
        protected override async Task SerializeToStreamAsync(Stream stream, System.Net.TransportContext? context)
        {
            var chunk = new byte[16 * 1024];
            for (var sent = 0; sent < sendBytes; sent += chunk.Length) await stream.WriteAsync(chunk);
            throw new IOException("connection dropped");
        }

        protected override bool TryComputeLength(out long length)
        {
            length = 0;
            return false;
        }
    }

    [Fact]
    public async Task Interrupted_upload_leaves_no_file_or_row_behind()
    {
        var (owner, serverId) = await OwnerAsync(factory);
        var files = QuarantineCount();
        var rows = await FileRowsAsync();

        var form = new MultipartFormDataContent();
        var part = new BrokenContent(512 * 1024);
        part.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        form.Add(part, "file", "big.png");
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await Assert.ThrowsAnyAsync<Exception>(() => owner.Http.PostAsync($"/api/v1/servers/{serverId}/attachments", form, cts.Token));

        await Task.Delay(500);
        Assert.Equal(files, QuarantineCount());
        Assert.True(await FileRowsAsync() <= rows, "no file row was created"); // GC may remove older orphans meanwhile
        Assert.Equal(rows, await FileRowsAsync());
        // The server is fine afterwards.
        Assert.Equal(HttpStatusCode.Created, (await UploadAsync(owner, $"/api/v1/servers/{serverId}/attachments", Png, "a.png")).StatusCode);
    }
}
