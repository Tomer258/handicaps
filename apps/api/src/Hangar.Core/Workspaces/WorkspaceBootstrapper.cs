using Hangar.Core.Channels;
using Hangar.Core.Identity;
using Hangar.Core.Permissions;
using Hangar.Core.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Hangar.Core.Workspaces;

public sealed class WorkspaceBootstrapOptions
{
    public string ServerName { get; set; } = "The Hangar";
    /// <summary>Optional public base URL used to print a clickable bootstrap invite link.</summary>
    public string PublicBaseUrl { get; set; } = "http://localhost:4200";
}

/// <summary>
/// First start: creates the single workspace with default roles and channels, then issues a one-time
/// owner-bootstrap invitation and logs its link. Later starts re-issue the link only while no owner exists.
/// </summary>
public sealed class WorkspaceBootstrapper(
    HangarDbContext db,
    InvitationService invitations,
    TimeProvider clock,
    ILogger<WorkspaceBootstrapper> log)
{
    public async Task<string?> EnsureAsync(WorkspaceBootstrapOptions opt, CancellationToken ct)
    {
        var server = await db.Servers.OrderBy(s => s.CreatedAt).FirstOrDefaultAsync(ct);
        if (server is null)
        {
            server = Seed(db, opt.ServerName, clock.GetUtcNow(), firstHangar: true);
            await db.SaveChangesAsync(ct);
            log.LogInformation("Created workspace {Name} ({Id})", server.Name, server.Id);
        }

        if (server.OwnerUserId is not null) return null;

        // Replace any previous unused bootstrap secret: secrets are never stored in plaintext, so we cannot re-print it.
        var now = clock.GetUtcNow();
        await db.Invitations
            .Where(i => i.ServerId == server.Id && i.Purpose == InvitationPurpose.OwnerBootstrap && i.RevokedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(i => i.RevokedAt, now), ct);

        var (invite, secret) = invitations.New(server.Id, null, InvitationPurpose.OwnerBootstrap, TimeSpan.FromDays(7), 1, "owner bootstrap");
        db.Invitations.Add(invite);
        await db.SaveChangesAsync(ct);

        var link = $"{opt.PublicBaseUrl.TrimEnd('/')}/invite/{secret}";
        log.LogWarning("No owner yet. Open this one-time owner invitation to create the owner account:\n\n    {Link}\n", link);
        return link;
    }

    /// <summary>
    /// A hangar with the three standard roles and starter channels. The first hangar of an install keeps its original
    /// starter set; hangars created later get a plain one (general, clips, Lounge, AFK).
    /// </summary>
    internal static Server Seed(HangarDbContext db, string name, DateTimeOffset now, bool firstHangar, Guid? ownerId = null)
    {
        var server = new Server { Id = Guid.CreateVersion7(), Name = name, CreatedAt = now, PolicyVersion = 1, OwnerUserId = ownerId };
        db.Servers.Add(server);

        db.Roles.AddRange(
            new Role { Id = Guid.CreateVersion7(), ServerId = server.Id, Name = "Member", IsDefault = true, PermissionMask = PermissionSets.Member, Position = 0 },
            new Role { Id = Guid.CreateVersion7(), ServerId = server.Id, Name = "Moderator", PermissionMask = PermissionSets.Moderator, Position = 1, Hoist = false, Color = "#8FB8FF" },
            new Role { Id = Guid.CreateVersion7(), ServerId = server.Id, Name = "Admin", PermissionMask = PermissionSets.Admin, Position = 2, Hoist = true, Color = "#C8F05A" });

        var pos = 0;
        (string, string?)[] text = firstHangar
            ?
            [
                ("general", "Anything goes. Game night is Thursday 21:00."),
                ("clips", "Proof or it did not happen."),
                ("memes", "Quality not guaranteed."),
                ("game-night", "Vote for Thursday's game."),
            ]
            : [("general", null), ("clips", null)];
        foreach (var (n, topic) in text)
            db.Channels.Add(new Channel { Id = Guid.CreateVersion7(), ServerId = server.Id, Type = ChannelType.Text, Name = n, Topic = topic, Position = pos++, CreatedAt = now });

        foreach (var n in firstHangar ? new[] { "Lounge", "Ranked Grind", "Movie Night", "AFK" } : ["Lounge", "AFK"])
            db.Channels.Add(new Channel { Id = Guid.CreateVersion7(), ServerId = server.Id, Type = ChannelType.Voice, Name = n, Position = pos++, CreatedAt = now });

        return server;
    }
}
