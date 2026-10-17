using Hangar.Api.Infrastructure;
using Hangar.Core.Channels;
using Hangar.Core.Identity;
using Hangar.Core.Users;
using Hangar.Core.Workspaces;

namespace Hangar.Api.Endpoints;

public sealed record CreateInvitationRequest(int? LifetimeHours, int? MaxUses, string? Note);
public sealed record InvitationDto(Guid Id, DateTimeOffset CreatedAt, DateTimeOffset ExpiresAt, int MaxUses, int UsedCount, string? Note);
public sealed record CreatedInvitationDto(InvitationDto Invitation, string Secret, string Url);
public sealed record CreateChannelRequest(string Type, string Name, string? Topic);
public sealed record UpdateChannelRequest(string? Name, string? Topic, int? Position);
public sealed record SetOverrideRequest(Guid? RoleId, Guid? MemberUserId, long Allow, long Deny);
public sealed record SetRolesRequest(List<Guid> RoleIds);
public sealed record UpdateRoleRequest(string? Name, long? Permissions, string? Color);
public sealed record UpdateProfileRequest(string? DisplayName, int? AvatarHue);

public static class WorkspaceEndpoints
{
    public static void MapWorkspaces(this RouteGroupBuilder api)
    {
        var servers = api.MapGroup("/servers").WithTags("Servers");

        servers.MapGet("/", async (HttpContext http, WorkspaceService ws, CancellationToken ct) =>
            Results.Ok(await ws.ListServersAsync(http.User.UserId(), ct)));

        servers.MapGet("/{serverId:guid}", async (Guid serverId, HttpContext http, WorkspaceService ws, CancellationToken ct) =>
            Results.Ok(await ws.GetServerAsync(http.User.UserId(), serverId, ct)));

        servers.MapGet("/{serverId:guid}/members", async (Guid serverId, HttpContext http, WorkspaceService ws, CancellationToken ct) =>
            Results.Ok(await ws.ListMembersAsync(http.User.UserId(), serverId, ct)));

        servers.MapPut("/{serverId:guid}/members/{userId:guid}/roles", async (Guid serverId, Guid userId, SetRolesRequest req,
            HttpContext http, WorkspaceService ws, CancellationToken ct) =>
        {
            await ws.SetMemberRolesAsync(http.User.UserId(), serverId, userId, req.RoleIds ?? [], ct);
            return Results.NoContent();
        });

        servers.MapDelete("/{serverId:guid}/members/{userId:guid}", async (Guid serverId, Guid userId, HttpContext http, WorkspaceService ws, CancellationToken ct) =>
        {
            await ws.RemoveMemberAsync(http.User.UserId(), serverId, userId, ct);
            return Results.NoContent();
        });

        servers.MapPatch("/{serverId:guid}/roles/{roleId:guid}", async (Guid serverId, Guid roleId, UpdateRoleRequest req,
            HttpContext http, WorkspaceService ws, CancellationToken ct) =>
        {
            await ws.UpdateRoleAsync(http.User.UserId(), serverId, roleId, req.Name, req.Permissions, req.Color, ct);
            return Results.NoContent();
        });

        servers.MapPost("/{serverId:guid}/invitations", async (Guid serverId, CreateInvitationRequest req, HttpContext http,
            InvitationService invites, Microsoft.Extensions.Options.IOptions<HangarOptions> opt, CancellationToken ct) =>
        {
            var created = await invites.CreateAsync(http.User.UserId(), serverId,
                req.LifetimeHours is { } h ? TimeSpan.FromHours(h) : null, req.MaxUses, req.Note, ct);
            var url = $"{opt.Value.PublicBaseUrl.TrimEnd('/')}/invite/{created.Secret}";
            // The secret is returned exactly once; only its hash is stored.
            return Results.Ok(new CreatedInvitationDto(ToDto(created.Invitation), created.Secret, url));
        });

        servers.MapGet("/{serverId:guid}/invitations", async (Guid serverId, HttpContext http, InvitationService invites, CancellationToken ct) =>
            Results.Ok((await invites.ListAsync(http.User.UserId(), serverId, ct)).Select(ToDto)));

        servers.MapDelete("/{serverId:guid}/invitations/{id:guid}", async (Guid serverId, Guid id, HttpContext http, InvitationService invites, CancellationToken ct) =>
        {
            await invites.RevokeAsync(http.User.UserId(), serverId, id, ct);
            return Results.NoContent();
        });

        servers.MapPost("/{serverId:guid}/channels", async (Guid serverId, CreateChannelRequest req, HttpContext http, ChannelService channels, CancellationToken ct) =>
            Results.Ok(await channels.CreateAsync(http.User.UserId(), serverId, req.Type, req.Name, req.Topic, ct)));

        var channels = api.MapGroup("/channels").WithTags("Channels");

        channels.MapPatch("/{channelId:guid}", async (Guid channelId, UpdateChannelRequest req, HttpContext http, ChannelService svc, CancellationToken ct) =>
            Results.Ok(await svc.UpdateAsync(http.User.UserId(), channelId, req.Name, req.Topic, req.Position, ct)));

        channels.MapDelete("/{channelId:guid}", async (Guid channelId, HttpContext http, ChannelService svc, CancellationToken ct) =>
        {
            await svc.ArchiveAsync(http.User.UserId(), channelId, ct);
            return Results.NoContent();
        });

        channels.MapGet("/{channelId:guid}/overrides", async (Guid channelId, HttpContext http, ChannelService svc, CancellationToken ct) =>
            Results.Ok(await svc.ListOverridesAsync(http.User.UserId(), channelId, ct)));

        channels.MapPut("/{channelId:guid}/overrides", async (Guid channelId, SetOverrideRequest req, HttpContext http, ChannelService svc, CancellationToken ct) =>
        {
            await svc.SetOverrideAsync(http.User.UserId(), channelId, req.RoleId, req.MemberUserId, req.Allow, req.Deny, ct);
            return Results.NoContent();
        });

        var me = api.MapGroup("/users/me").WithTags("Users");

        me.MapGet("/settings", async (HttpContext http, UserService users, CancellationToken ct) =>
            Results.Ok(await users.GetSettingsAsync(http.User.UserId(), ct)));

        me.MapPatch("/settings", async (SettingsPatch req, HttpContext http, UserService users, CancellationToken ct) =>
            Results.Ok(await users.PatchSettingsAsync(http.User.UserId(), req, ct)));

        me.MapPatch("/profile", async (UpdateProfileRequest req, HttpContext http, UserService users, CancellationToken ct) =>
            Results.Ok(await users.UpdateProfileAsync(http.User.UserId(), req.DisplayName, req.AvatarHue, ct)));
    }

    private static InvitationDto ToDto(Invitation i) => new(i.Id, i.CreatedAt, i.ExpiresAt, i.MaxUses, i.UsedCount, i.Note);
}
