using Hangar.Core.Audit;
using Hangar.Core.Common;
using Hangar.Core.Permissions;
using Hangar.Core.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Hangar.Core.Identity;

public sealed record CreatedInvitation(Invitation Invitation, string Secret);

/// <summary>Landing-page view. InvitedBy/MemberCount are shown only to holders of a valid secret.</summary>
/// <summary>ServerId lets a signed-in visitor see whether they are already in that hangar.</summary>
public sealed record InvitationPreview(bool Valid, string? ServerName, bool OwnerBootstrap, string? InvitedBy = null, int MemberCount = 0, Guid? ServerId = null);

public enum InvitationState { Active, UsedUp, Expired, Revoked }

public sealed record InvitedMember(Guid UserId, string DisplayName, DateTimeOffset JoinedAt);

/// <summary>Admin list row: who created it and who joined with it.</summary>
public sealed record InvitationView(Invitation Invitation, InvitationState State, string? CreatedByName, List<InvitedMember> Joined);

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

    /// <summary>Active invitations first, then spent ones until retention purges them (a week after they end).</summary>
    public async Task<List<InvitationView>> ListAsync(Guid actor, Guid serverId, CancellationToken ct)
    {
        await permissions.RequireServerAsync(actor, serverId, Permission.ManageInvites, ct);
        var now = clock.GetUtcNow();
        var rows = await db.Invitations.AsNoTracking()
            .Where(i => i.ServerId == serverId && i.Purpose == InvitationPurpose.Member)
            .OrderByDescending(i => i.CreatedAt).Take(100).ToListAsync(ct);
        var ids = rows.Select(i => i.Id).ToList();
        var creators = rows.Where(i => i.CreatedBy != null).Select(i => i.CreatedBy!.Value).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => creators.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var joined = (await db.ServerMembers.AsNoTracking()
                .Where(m => m.ServerId == serverId && m.InvitationId != null && ids.Contains(m.InvitationId.Value))
                .Join(db.Users, m => m.UserId, u => u.Id, (m, u) => new { m.InvitationId, u.Id, u.DisplayName, m.JoinedAt })
                .ToListAsync(ct))
            .ToLookup(j => j.InvitationId!.Value, j => new InvitedMember(j.Id, j.DisplayName, j.JoinedAt));

        return rows
            .Select(i => new InvitationView(i,
                i.RevokedAt != null ? InvitationState.Revoked
                : i.UsedCount >= i.MaxUses ? InvitationState.UsedUp
                : i.ExpiresAt <= now ? InvitationState.Expired
                : InvitationState.Active,
                i.CreatedBy is { } c ? names.GetValueOrDefault(c) : null,
                joined[i.Id].OrderBy(j => j.JoinedAt).ToList()))
            .OrderBy(v => v.State == InvitationState.Active ? 0 : 1).ThenByDescending(v => v.Invitation.CreatedAt)
            .ToList();
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

    /// <summary>Landing-page lookup. Only for a valid secret: the server name, who invited, and how many members.</summary>
    public async Task<InvitationPreview> PreviewAsync(string secret, CancellationToken ct)
    {
        var hash = Secrets.Sha256Hex(secret ?? "");
        var now = clock.GetUtcNow();
        var row = await db.Invitations.AsNoTracking()
            .Where(i => i.TokenHash == hash && i.RevokedAt == null && i.ExpiresAt > now && i.UsedCount < i.MaxUses)
            .Join(db.Servers, i => i.ServerId, s => s.Id, (i, s) => new { s.Name, i.Purpose, i.ServerId, i.CreatedBy })
            .FirstOrDefaultAsync(ct);
        if (row is null) return new InvitationPreview(false, null, false);
        var inviter = row.CreatedBy is { } by ? await db.Users.AsNoTracking().Where(u => u.Id == by).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) : null;
        var members = await db.ServerMembers.CountAsync(m => m.ServerId == row.ServerId && m.RemovedAt == null, ct);
        return new InvitationPreview(true, row.Name, row.Purpose == InvitationPurpose.OwnerBootstrap, inviter, members, row.ServerId);
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
