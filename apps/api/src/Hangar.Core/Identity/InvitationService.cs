using Hangar.Core.Audit;
using Hangar.Core.Common;
using Hangar.Core.Permissions;
using Hangar.Core.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Hangar.Core.Identity;

public sealed record CreatedInvitation(Invitation Invitation, string Secret);

public sealed record InvitationPreview(bool Valid, string? ServerName, bool OwnerBootstrap);

public sealed class InvitationService(
    HangarDbContext db,
    PermissionService permissions,
    AuditService audit,
    TimeProvider clock,
    IOptions<HangarIdentityOptions> options)
{
    private readonly HangarIdentityOptions _opt = options.Value;

    public async Task<CreatedInvitation> CreateAsync(Guid actor, Guid serverId, TimeSpan? lifetime, int? maxUses, string? note, CancellationToken ct)
    {
        await permissions.RequireServerAsync(actor, serverId, Permission.ManageInvites, ct);
        var life = lifetime is null || lifetime <= TimeSpan.Zero ? _opt.DefaultInviteLifetime
            : lifetime.Value > _opt.MaxInviteLifetime ? _opt.MaxInviteLifetime : lifetime.Value;
        var uses = Math.Clamp(maxUses ?? 1, 1, _opt.MaxInviteUses);
        var (invite, secret) = New(serverId, actor, InvitationPurpose.Member, life, uses, Guard.OptionalText(note, "note", 120));
        db.Invitations.Add(invite);
        audit.Record(actor, "invitation", invite.Id.ToString(), "invite.create", detail: $"uses={uses} life={life}");
        await db.SaveChangesAsync(ct);
        return new CreatedInvitation(invite, secret);
    }

    public async Task<List<Invitation>> ListAsync(Guid actor, Guid serverId, CancellationToken ct)
    {
        await permissions.RequireServerAsync(actor, serverId, Permission.ManageInvites, ct);
        var now = clock.GetUtcNow();
        return await db.Invitations.AsNoTracking()
            .Where(i => i.ServerId == serverId && i.Purpose == InvitationPurpose.Member && i.RevokedAt == null && i.ExpiresAt > now && i.UsedCount < i.MaxUses)
            .OrderByDescending(i => i.CreatedAt).Take(100).ToListAsync(ct);
    }

    public async Task RevokeAsync(Guid actor, Guid serverId, Guid invitationId, CancellationToken ct)
    {
        await permissions.RequireServerAsync(actor, serverId, Permission.ManageInvites, ct);
        var invite = await db.Invitations.FirstOrDefaultAsync(i => i.Id == invitationId && i.ServerId == serverId, ct)
                     ?? throw AppProblem.NotFound("invite.not_found", "Invitation not found.");
        if (invite.RevokedAt is null)
        {
            invite.RevokedAt = clock.GetUtcNow();
            audit.Record(actor, "invitation", invite.Id.ToString(), "invite.revoke");
            await db.SaveChangesAsync(ct);
        }
    }

    /// <summary>Landing-page lookup. Reveals only the server name, and only for a valid secret.</summary>
    public async Task<InvitationPreview> PreviewAsync(string secret, CancellationToken ct)
    {
        var hash = Secrets.Sha256Hex(secret ?? "");
        var now = clock.GetUtcNow();
        var row = await db.Invitations.AsNoTracking()
            .Where(i => i.TokenHash == hash && i.RevokedAt == null && i.ExpiresAt > now && i.UsedCount < i.MaxUses)
            .Join(db.Servers, i => i.ServerId, s => s.Id, (i, s) => new { s.Name, i.Purpose })
            .FirstOrDefaultAsync(ct);
        return row is null ? new InvitationPreview(false, null, false)
            : new InvitationPreview(true, row.Name, row.Purpose == InvitationPurpose.OwnerBootstrap);
    }

    internal (Invitation, string) New(Guid serverId, Guid? actor, InvitationPurpose purpose, TimeSpan life, int uses, string? note)
    {
        var secret = Secrets.NewToken();
        var now = clock.GetUtcNow();
        return (new Invitation
        {
            Id = Guid.CreateVersion7(),
            ServerId = serverId,
            TokenHash = Secrets.Sha256Hex(secret),
            Purpose = purpose,
            CreatedBy = actor,
            CreatedAt = now,
            ExpiresAt = now + life,
            MaxUses = uses,
            Note = note,
        }, secret);
    }
}
