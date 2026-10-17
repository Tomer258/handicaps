using Hangar.Api.Infrastructure;
using Hangar.Core.Messaging;

namespace Hangar.Api.Endpoints;

public sealed record ReadPositionRequest(string MessageSequence);
public sealed record PinRequest(bool Pinned);

public static class MessageEndpoints
{
    public static void MapMessages(this RouteGroupBuilder api)
    {
        var channels = api.MapGroup("/channels").WithTags("Messages");

        channels.MapGet("/{channelId:guid}/messages", async (Guid channelId, string? before, int? limit, HttpContext http, MessageService svc, CancellationToken ct) =>
            Results.Ok(await svc.HistoryAsync(http.User.UserId(), channelId, before, limit, ct)));

        channels.MapPost("/{channelId:guid}/messages", async (Guid channelId, SendMessageRequest req, HttpContext http, MessageService svc, CancellationToken ct) =>
        {
            var (message, created) = await svc.SendAsync(http.User.UserId(), channelId, req, ct);
            // 201 means durable commit — not that anyone has seen it yet. A retry returns the original with 200.
            return created ? Results.Created($"/api/v1/messages/{message.Id}", message) : Results.Ok(message);
        });

        channels.MapGet("/{channelId:guid}/pins", async (Guid channelId, HttpContext http, MessageService svc, CancellationToken ct) =>
            Results.Ok(await svc.PinnedAsync(http.User.UserId(), channelId, ct)));

        channels.MapGet("/{channelId:guid}/events", async (Guid channelId, string? after, int? limit, HttpContext http, MessageService svc, CancellationToken ct) =>
            Results.Ok(await svc.EventsAsync(http.User.UserId(), channelId, after, limit, ct)));

        channels.MapPut("/{channelId:guid}/read-position", async (Guid channelId, ReadPositionRequest req, HttpContext http, MessageService svc, CancellationToken ct) =>
        {
            await svc.UpdateReadPositionAsync(http.User.UserId(), channelId, req.MessageSequence, ct);
            return Results.NoContent();
        });

        var messages = api.MapGroup("/messages").WithTags("Messages");

        messages.MapPatch("/{messageId:guid}", async (Guid messageId, EditMessageRequest req, HttpContext http, MessageService svc, CancellationToken ct) =>
            Results.Ok(await svc.EditAsync(http.User.UserId(), messageId, req, ct)));

        messages.MapDelete("/{messageId:guid}", async (Guid messageId, long? expectedVersion, HttpContext http, MessageService svc, CancellationToken ct) =>
        {
            await svc.DeleteAsync(http.User.UserId(), messageId, expectedVersion, ct);
            return Results.NoContent();
        });

        messages.MapPut("/{messageId:guid}/reactions/{emoji}", async (Guid messageId, string emoji, HttpContext http, MessageService svc, CancellationToken ct) =>
        {
            await svc.SetReactionAsync(http.User.UserId(), messageId, emoji, true, ct);
            return Results.NoContent();
        });

        messages.MapDelete("/{messageId:guid}/reactions/{emoji}", async (Guid messageId, string emoji, HttpContext http, MessageService svc, CancellationToken ct) =>
        {
            await svc.SetReactionAsync(http.User.UserId(), messageId, emoji, false, ct);
            return Results.NoContent();
        });

        messages.MapPut("/{messageId:guid}/pin", async (Guid messageId, PinRequest req, HttpContext http, MessageService svc, CancellationToken ct) =>
        {
            await svc.SetPinnedAsync(http.User.UserId(), messageId, req.Pinned, ct);
            return Results.NoContent();
        });

        api.MapGet("/servers/{serverId:guid}/unread", async (Guid serverId, HttpContext http, MessageService svc, CancellationToken ct) =>
            Results.Ok(await svc.UnreadOverviewAsync(http.User.UserId(), serverId, ct))).WithTags("Messages");
    }
}
