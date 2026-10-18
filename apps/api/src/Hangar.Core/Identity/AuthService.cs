using System.Text.RegularExpressions;
using Hangar.Core.Audit;
using Hangar.Core.Common;
using Hangar.Core.Persistence;
using Hangar.Core.Users;
using Hangar.Core.Workspaces;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Hangar.Core.Identity;

public sealed record AuthResult(User User, UserSession Session);

/// <summary>Password step result: signed in, or (two-step login on) a pending user that still owes a code.</summary>
public sealed record LoginOutcome(AuthResult? SignedIn, Guid PendingUserId = default, int PendingSecurityVersion = 0);

public sealed partial class AuthService(
    HangarDbContext db,
    IPasswordHasher<User> hasher,
    TimeProvider clock,
    AuditService audit,
    LoginThrottle throttle,
    SessionRevocationNotifier revocation,
    TwoFactorService twoFactor,
    IOptions<HangarIdentityOptions> options)
{
    private readonly HangarIdentityOptions _opt = options.Value;

    [GeneratedRegex("^[a-z0-9._-]{3,32}$")]
    private static partial Regex LoginPattern();

    public static string NormalizeLogin(string login) => login.Trim().ToLowerInvariant();

    /// <summary>A hash of a random password with the current parameters, verified when the login does not exist.</summary>
    private static class TimingDummy
    {
        public static readonly User User = new() { Login = "-", NormalizedLogin = "-", DisplayName = "-" };
        private static string? _hash;
        public static string Hash(IPasswordHasher<User> hasher) =>
            _hash ??= hasher.HashPassword(User, Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(24)));
    }

    public async Task<AuthResult> RegisterAsync(string inviteSecret, string login, string password, string displayName,
        bool remember, string? deviceLabel, CancellationToken ct)
    {
        var normalized = NormalizeLogin(login ?? "");
        if (!LoginPattern().IsMatch(normalized))
            throw AppProblem.BadRequest("validation.login", "Login must be 3–32 characters: letters, digits, dot, dash or underscore.");
        ValidatePassword(password);
        var name = Guard.Text(displayName, "displayName", 1, 32);
        var tokenHash = Secrets.Sha256Hex(inviteSecret ?? "");
        var now = clock.GetUtcNow();

        await using var tx = await db.Database.BeginTransactionAsync(ct);

        // Lock the invitation row so concurrent redemptions cannot exceed max uses.
        var invite = await db.Invitations
            .FromSql($"SELECT * FROM invitations WHERE token_hash = {tokenHash} FOR UPDATE")
            .FirstOrDefaultAsync(ct);
        if (invite is null || invite.RevokedAt != null || invite.ExpiresAt <= now || invite.UsedCount >= invite.MaxUses)
            throw AppProblem.BadRequest("invite.invalid", "This invitation is invalid, expired or already used.");

        if (await db.Users.AnyAsync(u => u.NormalizedLogin == normalized, ct))
            throw AppProblem.Conflict("auth.login_taken", "That login is already taken.");

        var user = new User
        {
            Id = Guid.CreateVersion7(),
            Login = login!.Trim(),
            NormalizedLogin = normalized,
            DisplayName = name,
            AvatarHue = Random.Shared.Next(0, 360),
            CreatedAt = now,
        };
        user.PasswordHash = hasher.HashPassword(user, password);
        db.Users.Add(user);
        db.UserSettings.Add(new UserSettings { UserId = user.Id });
        db.ServerMembers.Add(new ServerMember { ServerId = invite.ServerId, UserId = user.Id, JoinedAt = now, MemberVersion = 1 });

        if (invite.Purpose == InvitationPurpose.OwnerBootstrap)
        {
            var server = await db.Servers.FirstAsync(s => s.Id == invite.ServerId, ct);
            if (server.OwnerUserId is not null)
                throw AppProblem.BadRequest("invite.invalid", "This invitation is invalid, expired or already used.");
            server.OwnerUserId = user.Id;
            server.PolicyVersion++;
        }

        invite.UsedCount++;
        var session = NewSession(user, remember, deviceLabel, now);
        db.UserSessions.Add(session);
        audit.Record(user.Id, "user", user.Id.ToString(), "auth.register", detail: $"invite={invite.Id} purpose={invite.Purpose}");

        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (ex.InnerException is Npgsql.PostgresException { SqlState: "23505" })
        {
            throw AppProblem.Conflict("auth.login_taken", "That login is already taken.");
        }
        await tx.CommitAsync(ct);
        return new AuthResult(user, session);
    }

    public async Task<LoginOutcome> LoginAsync(string login, string password, bool remember, string? deviceLabel, string clientIp, CancellationToken ct)
    {
        var normalized = NormalizeLogin(login ?? "");
        throttle.EnsureAllowed(normalized, clientIp);

        var user = await db.Users.FirstOrDefaultAsync(u => u.NormalizedLogin == normalized, ct);
        // Always pay for one hash verification, so an unknown login is not measurably faster than a wrong password.
        var result = hasher.VerifyHashedPassword(user ?? TimingDummy.User, user?.PasswordHash ?? TimingDummy.Hash(hasher), password ?? "");
        var verified = user is not null && user.DisabledAt is null && result != PasswordVerificationResult.Failed;
        if (user is null || !verified)
        {
            throttle.RecordFailure(normalized, clientIp);
            // Same message for unknown login, wrong password and disabled account: no login enumeration.
            throw AppProblem.Unauthorized("auth.invalid_credentials", "Login or password is incorrect.");
        }

        throttle.RecordSuccess(normalized, clientIp);
        var now = clock.GetUtcNow();
        if (result == PasswordVerificationResult.SuccessRehashNeeded)
            user.PasswordHash = hasher.HashPassword(user, password!);
        if (user.TwoFactorEnabledAt is not null)
        {
            await db.SaveChangesAsync(ct); // a rehash, if any; no session until the code step
            return new LoginOutcome(null, user.Id, user.SecurityVersion);
        }
        return new LoginOutcome(await StartSessionAsync(user, remember, deviceLabel, now, ct));
    }

    /// <summary>
    /// Second login step. <paramref name="securityVersion"/> comes from the protected challenge: a password change or
    /// disable between the two steps invalidates it.
    /// </summary>
    public async Task<AuthResult> CompleteTwoFactorLoginAsync(Guid userId, int securityVersion, string code, bool remember,
        string? deviceLabel, string clientIp, CancellationToken ct)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);
        if (user is null || user.DisabledAt is not null || user.SecurityVersion != securityVersion || user.TwoFactorEnabledAt is null)
            throw AppProblem.Unauthorized("auth.challenge_expired", "Sign in again.");
        await twoFactor.VerifyLoginAsync(user, code, clientIp, ct);
        return await StartSessionAsync(user, remember, deviceLabel, clock.GetUtcNow(), ct);
    }

    private async Task<AuthResult> StartSessionAsync(User user, bool remember, string? deviceLabel, DateTimeOffset now, CancellationToken ct)
    {
        var session = NewSession(user, remember, deviceLabel, now);
        db.UserSessions.Add(session);
        audit.Record(user.Id, "session", session.Id.ToString(), "auth.login");
        await db.SaveChangesAsync(ct);
        return new AuthResult(user, session);
    }

    /// <summary>
    /// Authoritative per-request session check. Returns false when revoked, expired, disabled or security-version stale.
    /// Slides the idle expiry (bounded by the absolute cap) at most once a minute.
    /// </summary>
    public async Task<bool> ValidateSessionAsync(Guid sessionId, Guid userId, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        var row = await db.UserSessions
            .Join(db.Users, s => s.UserId, u => u.Id, (s, u) => new { Session = s, u.DisabledAt, u.SecurityVersion })
            .FirstOrDefaultAsync(x => x.Session.Id == sessionId && x.Session.UserId == userId, ct);
        if (row is null) return false;
        var s = row.Session;
        if (s.RevokedAt != null || row.DisabledAt != null || s.SecurityVersion != row.SecurityVersion) return false;
        if (s.IdleExpiresAt <= now || s.AbsoluteExpiresAt <= now) return false;

        if (now - s.LastSeenAt > TimeSpan.FromMinutes(1))
        {
            var idle = s.Persistent ? _opt.PersistentIdle : _opt.BrowserSessionIdle;
            s.LastSeenAt = now;
            s.IdleExpiresAt = Min(now + idle, s.AbsoluteExpiresAt);
            await db.SaveChangesAsync(ct);
        }
        return true;
    }

    public async Task LogoutAsync(Guid userId, Guid sessionId, CancellationToken ct)
    {
        var s = await db.UserSessions.FirstOrDefaultAsync(x => x.Id == sessionId && x.UserId == userId, ct);
        if (s is null || s.RevokedAt != null) return;
        s.RevokedAt = clock.GetUtcNow();
        audit.Record(userId, "session", sessionId.ToString(), "auth.logout");
        await db.SaveChangesAsync(ct);
        await revocation.NotifyAsync(userId, [sessionId], "logout", ct);
    }

    public async Task<List<UserSession>> ListSessionsAsync(Guid userId, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        return await db.UserSessions.AsNoTracking()
            .Where(s => s.UserId == userId && s.RevokedAt == null && s.AbsoluteExpiresAt > now && s.IdleExpiresAt > now)
            .OrderByDescending(s => s.LastSeenAt).Take(50).ToListAsync(ct);
    }

    public async Task RevokeSessionAsync(Guid userId, Guid sessionId, CancellationToken ct)
    {
        var s = await db.UserSessions.FirstOrDefaultAsync(x => x.Id == sessionId && x.UserId == userId, ct)
                ?? throw AppProblem.NotFound("session.not_found", "Session not found.");
        if (s.RevokedAt == null)
        {
            s.RevokedAt = clock.GetUtcNow();
            audit.Record(userId, "session", sessionId.ToString(), "auth.session_revoke");
            await db.SaveChangesAsync(ct);
        }
        await revocation.NotifyAsync(userId, [sessionId], "revoked", ct);
    }

    public async Task ChangePasswordAsync(Guid userId, Guid currentSessionId, string currentPassword, string newPassword, CancellationToken ct)
    {
        var user = await db.Users.FirstAsync(u => u.Id == userId, ct);
        if (hasher.VerifyHashedPassword(user, user.PasswordHash, currentPassword ?? "") == PasswordVerificationResult.Failed)
            throw AppProblem.BadRequest("auth.invalid_password", "Current password is incorrect.");
        ValidatePassword(newPassword);
        user.PasswordHash = hasher.HashPassword(user, newPassword);

        // Revoke every other session; keep the current one valid by moving it to the new security version.
        user.SecurityVersion++;
        var now = clock.GetUtcNow();
        var others = await db.UserSessions.Where(s => s.UserId == userId && s.RevokedAt == null).ToListAsync(ct);
        foreach (var s in others)
        {
            if (s.Id == currentSessionId) s.SecurityVersion = user.SecurityVersion;
            else s.RevokedAt = now;
        }
        audit.Record(userId, "user", userId.ToString(), "auth.password_change");
        await db.SaveChangesAsync(ct);
        await revocation.NotifyAsync(userId, others.Where(s => s.Id != currentSessionId).Select(s => s.Id).ToList(), "password_changed", ct);
    }

    private void ValidatePassword(string? password)
    {
        if (password is null || password.Length < _opt.MinPasswordLength || password.Length > 128)
            throw AppProblem.BadRequest("validation.password", $"Password must be {_opt.MinPasswordLength}–128 characters.");
    }

    private UserSession NewSession(User user, bool remember, string? deviceLabel, DateTimeOffset now)
    {
        var idle = remember ? _opt.PersistentIdle : _opt.BrowserSessionIdle;
        var absolute = remember ? _opt.PersistentAbsolute : _opt.BrowserSessionAbsolute;
        return new UserSession
        {
            Id = Guid.CreateVersion7(),
            UserId = user.Id,
            CreatedAt = now,
            LastSeenAt = now,
            IdleExpiresAt = now + idle,
            AbsoluteExpiresAt = now + absolute,
            Persistent = remember,
            SecurityVersion = user.SecurityVersion,
            DeviceLabel = Guard.OptionalText(deviceLabel, "deviceLabel", 120),
        };
    }

    private static DateTimeOffset Min(DateTimeOffset a, DateTimeOffset b) => a < b ? a : b;
}
